import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess
} from 'node:child_process'
import { resolveSpawn, type ResolvedSpawn } from './spawn-resolution'
import { forceTerminateProcessTree, signalProcessTree } from './process-tree-termination'
import { inFlightWindowsTreeKill } from './windows-tree-kill'

import { hasSpawnObserver, notifySpawnObserver } from './spawn-observer'
import { createOutputSink } from './bounded-output-sink'
import { createChildTerminationReporter } from './child-termination-reporter'

export { WindowsCmdLineBreakError } from './windows-command-line'

import type {
  PipedChildProcess,
  PipedProcessSpec,
  ProcessSpec,
  ProcessResult
} from './process-spec'
import { DEFAULT_PROCESS_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } from './process-spec'
// Bound waits for children that ignore termination and never emit close.
const PROCESS_EXIT_GRACE_MS = 2_000
// An unverifiable, silent tree must not leave barrier callers pending forever.
const BARRIER_UNVERIFIED_EXIT_GRACE_MS = 10_000

/** Callers own stream error handling; unhandled stream errors can crash the host process. */
export function spawnProcess(spec: PipedProcessSpec): PipedChildProcess
export function spawnProcess(spec: ProcessSpec): ChildProcess
export function spawnProcess(spec: ProcessSpec): ChildProcess {
  const resolved = resolveSpawn(spec, process.platform)
  // uv_spawn blocks the calling thread; measure that block for diagnostics.
  const spawnStartedAt = hasSpawnObserver() ? performance.now() : null
  const child = nodeSpawn(resolved.file, [...resolved.args], resolved.options)
  if (spawnStartedAt !== null) {
    notifySpawnObserver(resolved.file, resolved.args, performance.now() - spawnStartedAt)
  }
  return child
}

/** Nonzero exits resolve; spawn errors reject. Tail capture preserves final diagnostics. */
export function runProcess(
  spec: ProcessSpec,
  outputCapture: 'head' | 'tail' = 'head'
): Promise<ProcessResult> {
  if (spec.signal?.aborted) {
    spec.onChildTerminated?.()
    return Promise.resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false })
  }
  const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return new Promise<ProcessResult>((resolve, reject) => {
    const terminationReporter = createChildTerminationReporter(spec.onChildTerminated)
    let child: ChildProcess
    try {
      child = spawnProcess(spec)
    } catch (error) {
      terminationReporter.report()
      reject(error)
      return
    }

    const stdout = createOutputSink(maxOutputBytes, outputCapture)
    const stderr = createOutputSink(maxOutputBytes, outputCapture)
    let timedOut = false
    let settled = false
    let barrierStopping = false
    let barrierAttemptComplete = false
    let barrierTerminationVerified = false
    let initialBarrierTermination: Promise<boolean> | undefined
    let deferredExit: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let deferredClose: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let deferredError: Error | null = null
    let rootExitedBeforeBarrier = false

    const settle = (act: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      clearTimeout(barrierDeadlineTimer)
      spec.signal?.removeEventListener('abort', onAbort)
      act()
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout.write(chunk)
      if (spec.killOnOutputLimit && stdout.truncated()) {
        stopAndSettle()
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr.write(chunk)
      spec.onStderr?.(chunk)
      if (spec.killOnOutputLimit && stderr.truncated()) {
        stopAndSettle()
      }
      if (typeof spec.terminationBarrier === 'object') {
        spec.terminationBarrier.observeStderr?.(chunk)
      }
    })
    // Stream errors (including stdin EPIPE) are otherwise uncaught; the exit still reaches callers.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on('error', () => {})
    }

    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let barrierDeadlineTimer: ReturnType<typeof setTimeout> | undefined
    const signalBarrierTree = (signal?: NodeJS.Signals): Promise<boolean> =>
      (typeof spec.terminationBarrier === 'object'
        ? spec.terminationBarrier.signal(child, signal)
        : signalProcessTree(child, signal)
      ).catch(() => false)
    const forceBarrierTree = (): Promise<boolean> =>
      (typeof spec.terminationBarrier === 'object'
        ? spec.terminationBarrier.force(child)
        : forceTerminateProcessTree(child)
      ).catch(() => false)

    const resolveFromClose = (code: number | null, signal: NodeJS.Signals | null): void =>
      settle(() =>
        resolve({
          code,
          signal,
          stdout: spec.captureStdoutAsBytes ? '' : stdout.text(),
          ...(spec.captureStdoutAsBytes ? { stdoutBytes: stdout.buffer() } : {}),
          stderr: stderr.text(),
          timedOut,
          outputTruncated: stdout.truncated() || stderr.truncated()
        })
      )

    const settleBarrierOutcome = (): void => {
      const rootExit = deferredClose ?? deferredExit
      if (deferredError) {
        settle(() => reject(deferredError))
        return
      }
      resolveFromClose(rootExit?.code ?? null, rootExit?.signal ?? null)
    }

    const markBarrierTerminationVerified = (): void => {
      barrierAttemptComplete = true
      barrierTerminationVerified = true
      terminationReporter.report()
      resolveBarrierIfSafe()
    }
    // Let taskkill finish reading the tree before killing the root, or descendants may be orphaned.
    const killRootUnlessTreeKillInFlight = (): void => {
      if (!inFlightWindowsTreeKill(child)) {
        terminate(child, 'SIGKILL')
      }
    }

    const resolveBarrierIfSafe = (): void => {
      const rootExit = deferredClose ?? deferredExit
      if (barrierTerminationVerified || (rootExitedBeforeBarrier && rootExit)) {
        settleBarrierOutcome()
        return
      }
      if (!barrierAttemptComplete) {
        return
      }
      // Nothing else can settle a silent tree after all termination attempts fail.
      barrierDeadlineTimer ??= setTimeout(settleBarrierOutcome, BARRIER_UNVERIFIED_EXIT_GRACE_MS)
      barrierDeadlineTimer.unref?.()
    }

    // Barrier callers wait for termination evidence, bounded by a final deadline.
    const stopAndSettle = (): void => {
      if (spec.terminationBarrier) {
        barrierStopping = true
        initialBarrierTermination ??= signalBarrierTree()
        if (process.platform === 'win32') {
          // The tracked taskkill outlives the caller's wait; a late success still verifies.
          void inFlightWindowsTreeKill(child)?.then(
            (verdict) => verdict === 'exited' && markBarrierTerminationVerified()
          )
          void initialBarrierTermination.then(
            (terminated) => terminated && markBarrierTerminationVerified()
          )
        }
      } else {
        terminate(child)
      }
      graceTimer ??= setTimeout(() => {
        if (spec.terminationBarrier) {
          const initialTermination = initialBarrierTermination ?? Promise.resolve(false)
          if (process.platform === 'win32') {
            if (typeof spec.terminationBarrier === 'object') {
              void Promise.all([initialTermination, forceBarrierTree()]).then(
                ([initialTerminated, forceTerminated]) => {
                  barrierAttemptComplete = true
                  barrierTerminationVerified = initialTerminated || forceTerminated
                  terminationReporter.reportIf(barrierTerminationVerified)
                  if (!barrierTerminationVerified) {
                    // Unverified termination must not leave the root running beyond abort/timeout.
                    killRootUnlessTreeKillInFlight()
                  }
                  resolveBarrierIfSafe()
                }
              )
              return
            }
            void initialTermination.then((terminated) => {
              if (!terminated) {
                killRootUnlessTreeKillInFlight()
              }
              barrierAttemptComplete = true
              barrierTerminationVerified = terminated
              terminationReporter.reportIf(barrierTerminationVerified)
              resolveBarrierIfSafe()
            })
            return
          }
          void Promise.all([initialTermination, forceBarrierTree()]).then(
            ([_initialTerminated, forceTerminated]) => {
              barrierAttemptComplete = true
              barrierTerminationVerified = forceTerminated
              terminationReporter.reportIf(barrierTerminationVerified)
              if (!barrierTerminationVerified) {
                terminate(child, 'SIGKILL')
              }
              resolveBarrierIfSafe()
            }
          )
          return
        }
        terminate(child, 'SIGKILL')
        resolveFromClose(null, null)
      }, PROCESS_EXIT_GRACE_MS)
      graceTimer.unref?.()
    }

    const timer =
      spec.timeoutMs === null
        ? undefined
        : setTimeout(() => {
            timedOut = true
            stopAndSettle()
          }, spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS)
    timer?.unref?.()

    const onAbort = (): void => stopAndSettle()
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    // Already-aborted signals emit no event; recheck after subscribing to close the race.
    if (spec.signal?.aborted) {
      onAbort()
    }

    child.once('error', (error) => {
      terminationReporter.reportIf(!child.pid)
      if (barrierStopping) {
        deferredError = error
        resolveBarrierIfSafe()
        return
      }
      settle(() => reject(error))
    })
    child.once('exit', (code, signal) => {
      if (!barrierStopping) {
        rootExitedBeforeBarrier = true
      }
      deferredExit = { code, signal }
      if (barrierStopping) {
        resolveBarrierIfSafe()
      }
    })
    child.once('close', (code, signal) => {
      terminationReporter.report()
      if (!barrierStopping) {
        rootExitedBeforeBarrier = true
      }
      if (barrierStopping) {
        deferredClose = { code, signal }
        resolveBarrierIfSafe()
        return
      }
      resolveFromClose(code, signal)
    })

    // Send EOF so stdin readers do not wait until timeout.
    child.stdin?.end(spec.input)
  })
}

// Best-effort root termination; tree termination is handled separately.
function terminate(child: ChildProcess, signal?: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    /* already gone */
  }
}

/** Prefer runProcess; reserve blocking execution for synchronous entry points and teardown. */
export function runProcessSync(spec: ProcessSpec): ProcessResult {
  const resolved = resolveSpawn(spec, process.platform)
  // spawnSync blocks until exit; report that duration even if it throws.
  const spawnStartedAt = hasSpawnObserver() ? performance.now() : null
  try {
    return runResolvedProcessSync(spec, resolved)
  } finally {
    if (spawnStartedAt !== null) {
      notifySpawnObserver(resolved.file, resolved.args, performance.now() - spawnStartedAt)
    }
  }
}

function runResolvedProcessSync(spec: ProcessSpec, resolved: ResolvedSpawn): ProcessResult {
  const result = nodeSpawnSync(resolved.file, [...resolved.args], {
    ...resolved.options,
    input: spec.input,
    timeout: spec.timeoutMs === null ? undefined : (spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS),
    maxBuffer: spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    // Keep raw output without applying the nonexistent 'buffer' encoding to string stdin.
    encoding: null
  })
  const timedOut = result.error
    ? 'code' in result.error && result.error.code === 'ETIMEDOUT'
    : false
  if (result.error && !timedOut) {
    throw result.error
  }
  return {
    code: result.status,
    signal: result.signal,
    stdout: spec.captureStdoutAsBytes ? '' : (result.stdout?.toString('utf8') ?? ''),
    ...(spec.captureStdoutAsBytes ? { stdoutBytes: result.stdout ?? Buffer.alloc(0) } : {}),
    stderr: result.stderr?.toString('utf8') ?? '',
    // ENOBUFS is rethrown above, so truncated output never reaches this result.
    outputTruncated: false,
    // SIGTERM can be deliberate; only ETIMEDOUT proves a timeout.
    timedOut
  }
}
