import { inFlightWindowsTreeKill } from './windows-tree-kill'
import { createPosixGroupTermination, PROCESS_EXIT_GRACE_MS } from './posix-group-termination'

import { createOutputSink } from './bounded-output-sink'
import { createChildTerminationReporter } from './child-termination-reporter'

import type {
  BufferedProcessChild,
  BufferedProcessSpawn,
  ProcessSpec,
  ProcessResult
} from './process-spec'
import { DEFAULT_MAX_OUTPUT_BYTES } from './process-spec'
import { selectBufferedProcessSpawn } from './process-spawn-selection'
import { startProcessDeadline } from './run-process-deadline'
import { createProcessTreeActions, terminate } from './run-process-tree-actions'

export { setBufferedProcessSpawner, spawnProcess } from './process-spawn-selection'
// An unverifiable, silent tree must not leave barrier callers pending forever.
const BARRIER_UNVERIFIED_EXIT_GRACE_MS = 10_000

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
    let child: BufferedProcessChild
    let hosted: BufferedProcessSpawn | undefined
    try {
      const selected = selectBufferedProcessSpawn(spec)
      hosted = selected.hosted
      child = selected.child
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
    const nativeGroupTermination =
      spec.terminationBarrier === true && process.platform !== 'win32'
        ? createPosixGroupTermination(child, () => {
            terminationReporter.report()
            if (barrierStopping) {
              markBarrierTerminationVerified()
            }
          })
        : undefined

    const settle = (act: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearDeadline()
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
    const { signalBarrierTree, forceBarrierTree, killRootUnlessTreeKillInFlight } =
      createProcessTreeActions(spec, child, hosted, () => markBarrierTerminationVerified())

    const resolveFromClose = (code: number | null, signal: NodeJS.Signals | null): void =>
      settle(() =>
        resolve({
          code,
          signal,
          stdout: spec.captureStdoutAsBytes ? '' : stdout.text(),
          ...(spec.captureStdoutAsBytes ? { stdoutBytes: stdout.buffer() } : {}),
          stderr: spec.captureStderrAsBytes ? '' : stderr.text(),
          ...(spec.captureStderrAsBytes ? { stderrBytes: stderr.buffer() } : {}),
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
    const resolveBarrierIfSafe = (): void => {
      const rootExit = deferredClose ?? deferredExit
      if (
        barrierTerminationVerified ||
        (!nativeGroupTermination && rootExitedBeforeBarrier && rootExit)
      ) {
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
      if (nativeGroupTermination) {
        if (barrierStopping) {
          return
        }
        barrierStopping = true
        void nativeGroupTermination.stop().then((verified) => {
          barrierAttemptComplete = true
          barrierTerminationVerified = verified
          resolveBarrierIfSafe()
        })
        return
      }
      if (spec.terminationBarrier) {
        barrierStopping = true
        initialBarrierTermination ??= signalBarrierTree()
        if (process.platform === 'win32' && !hosted?.withPid) {
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

    const clearDeadline = startProcessDeadline(
      spec,
      child,
      Boolean(hosted),
      () => settled,
      () => {
        timedOut = true
        stopAndSettle()
      }
    )

    const onAbort = (): void => stopAndSettle()
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    // Already-aborted signals emit no event; recheck after subscribing to close the race.
    if (spec.signal?.aborted) {
      onAbort()
    }

    const onError = (error: Error): void => {
      if (hosted?.isStdinWriteError?.(error)) {
        return
      }
      if (hosted?.isAbandonedError?.(error)) {
        terminationReporter.report()
        settle(() => reject(error))
        return
      }
      terminationReporter.reportIf(!child.pid)
      if (barrierStopping) {
        deferredError = error
        resolveBarrierIfSafe()
        return
      }
      settle(() => reject(error))
    }
    if (hosted) {
      child.on('error', onError)
    } else {
      child.once('error', onError)
    }
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
      deferredClose = { code, signal }
      if (nativeGroupTermination) {
        nativeGroupTermination.close()
      } else {
        terminationReporter.report()
      }
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

export { runProcessSync } from './run-process-sync'
