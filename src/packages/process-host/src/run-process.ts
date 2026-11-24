import type { ChildProcess } from 'node:child_process'
import { spawnProcess } from './spawn-process'
import { createPosixGroupTermination, PROCESS_EXIT_GRACE_MS } from './posix-group-termination'
import { forceTerminateProcessTree, signalProcessTree } from './process-tree-termination'
import { inFlightWindowsTreeKill } from './windows-tree-kill'

import { createOutputSink } from './bounded-output-sink'
import * as childTermination from './child-termination-reporter'
import type { LaunchedProcess, ProcessSpec, ProcessResult } from './process-spec'
import { DEFAULT_PROCESS_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } from './process-spec'
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
  const waitForPosixGroup = spec.terminationBarrier === 'wait-for-posix-group'
  const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return new Promise<ProcessResult>((resolve, reject) => {
    const terminationReporter = childTermination.createChildTerminationReporter(
      spec.onChildTerminated
    )
    let child: ChildProcess
    let launched: LaunchedProcess | null = null
    try {
      launched = spec.launch?.(spec) ?? null
      child = launched?.child ?? spawnProcess(spec)
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
    const onGroupTerminated = (): void => {
      terminationReporter.report()
      if (barrierStopping) {
        markBarrierTerminationVerified()
      }
    }
    const nativeGroupTermination =
      (spec.terminationBarrier === true || waitForPosixGroup) && process.platform !== 'win32'
        ? createPosixGroupTermination(child, onGroupTerminated, waitForPosixGroup)
        : undefined

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
        if (barrierStopping && spec.terminationBarrier.isExitVerified?.()) {
          markBarrierTerminationVerified()
        }
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
    // Let taskkill finish reading the tree before killing the root, or descendants may be orphaned.
    const killRootUnlessTreeKillInFlight = (): void => {
      if (!inFlightWindowsTreeKill(child)) {
        childTermination.terminateChild(child, 'SIGKILL')
      }
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
        childTermination.terminateChild(child)
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
                childTermination.terminateChild(child, 'SIGKILL')
              }
              resolveBarrierIfSafe()
            }
          )
          return
        }
        childTermination.terminateChild(child, 'SIGKILL')
        resolveFromClose(null, null)
      }, PROCESS_EXIT_GRACE_MS)
      graceTimer.unref?.()
    }

    // A launched child's pid arrives later; stopping before it would kill only a root, or nothing, and claim the tree ended.
    let awaitingPid = launched !== null && child.pid === undefined
    let stopDeferred = false
    const requestStop = (): void => {
      if (!awaitingPid) {
        stopAndSettle()
        return
      }
      if (stopDeferred) {
        return
      }
      stopDeferred = true
      launched?.withdrawPendingLaunch()
      // A stalled launcher must not hold the caller; termination is still reported only by the child.
      graceTimer ??= setTimeout(() => resolveFromClose(null, null), PROCESS_EXIT_GRACE_MS)
      graceTimer.unref?.()
    }
    if (awaitingPid) {
      child.once('spawn', () => {
        awaitingPid = false
        if (stopDeferred) {
          clearTimeout(graceTimer)
          graceTimer = undefined
          stopAndSettle()
        }
      })
    }

    const timer =
      spec.timeoutMs === null
        ? undefined
        : setTimeout(() => {
            timedOut = true
            requestStop()
          }, spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS)
    timer?.unref?.()

    const onAbort = (): void => requestStop()
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
      rootExitedBeforeBarrier ||= !barrierStopping
      deferredExit = { code, signal }
      if (barrierStopping) {
        resolveBarrierIfSafe()
      }
    })
    child.once('close', (code, signal) => {
      deferredClose = { code, signal }
      if (nativeGroupTermination) {
        if (!barrierStopping && (code === null || signal !== null)) {
          stopAndSettle()
        }
        nativeGroupTermination.close()
      } else if (
        childTermination.canReportChildClose(spec.terminationBarrier, barrierStopping, code, signal)
      ) {
        terminationReporter.report()
      }
      rootExitedBeforeBarrier ||= !barrierStopping
      if (barrierStopping) {
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
export { spawnProcess } from './spawn-process'
