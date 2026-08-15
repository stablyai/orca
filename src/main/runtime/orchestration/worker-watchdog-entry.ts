import { spawn } from 'node:child_process'
import {
  captureDescendantSnapshot,
  descendantSnapshotHasAmbiguousIdentity,
  DESCENDANT_KILL_GRACE_MS,
  forceTerminateDescendantSnapshot,
  signalLiveDescendantSnapshot,
  terminateDescendantSnapshot,
  type DescendantSnapshot
} from '../../pty-descendant-termination'
import { terminateWindowsProcessTree } from '../../windows-process-tree-kill'
import {
  verifyWindowsTreeKillTarget,
  type WindowsTreeKillTarget
} from '../../windows-pty-root-identity'
import { parseWorkerWatchdogRequest, type WorkerWatchdogSentinel } from './worker-watchdog-protocol'
import { runWorkerWatchdogEntry } from './worker-watchdog-entry-runner'
import type { WatchdogTimer, WorkerWatchdogRuntimeDeps } from './worker-watchdog-runtime-deps'
import { writeWorkerWatchdogSentinelAtomically } from './worker-watchdog-sentinel-file'

export { writeWorkerWatchdogSentinelAtomically } from './worker-watchdog-sentinel-file'

export function workerProcessGroupTarget(pid: number, platform: NodeJS.Platform): number {
  return platform === 'win32' ? pid : -pid
}
export function runWorkerWatchdog(
  requestValue: unknown,
  deps: WorkerWatchdogRuntimeDeps = {}
): Promise<WorkerWatchdogSentinel> {
  const request = parseWorkerWatchdogRequest(requestValue)
  const platform = deps.platform ?? process.platform
  const spawnImpl = deps.spawnImpl ?? spawn
  const now = deps.now ?? Date.now
  const setTimer =
    deps.setTimeoutImpl ??
    ((callback: () => void, delay: number) => setTimeout(callback, delay) as NodeJS.Timeout)
  const clearTimer = deps.clearTimeoutImpl ?? ((timer: WatchdogTimer) => clearTimeout(timer))
  const killImpl = deps.killImpl ?? process.kill
  const terminateWindowsTreeImpl = deps.terminateWindowsTreeImpl ?? terminateWindowsProcessTree
  const captureDescendants =
    deps.captureDescendantsImpl ??
    (deps.spawnImpl ? async () => null : (pid: number) => captureDescendantSnapshot(pid))
  const terminateDescendants = deps.terminateDescendantsImpl ?? terminateDescendantSnapshot
  const forceTerminateDescendants =
    deps.forceTerminateDescendantsImpl ?? forceTerminateDescendantSnapshot
  const signalLiveDescendants =
    deps.signalLiveDescendantsImpl ??
    ((snapshot: DescendantSnapshot, signal: NodeJS.Signals) =>
      signalLiveDescendantSnapshot(snapshot, signal))
  const verifyWindowsTreeKillTargetImpl =
    deps.verifyWindowsTreeKillTargetImpl ??
    (deps.spawnImpl ? async () => 'own' as const : verifyWindowsTreeKillTarget)
  const sweepDetachedDescendants = !deps.spawnImpl || Boolean(deps.captureDescendantsImpl)
  const writeSentinel = deps.writeSentinelImpl ?? writeWorkerWatchdogSentinelAtomically
  const child = spawnImpl(request.command, request.args, {
    cwd: request.cwd,
    env: { ...process.env, ...request.env },
    detached: platform !== 'win32',
    windowsHide: true,
    stdio: 'inherit'
  })
  const providerPid = child.pid
  if (!providerPid || !Number.isInteger(providerPid) || providerPid <= 0) {
    child.kill()
    throw new Error('Worker watchdog could not establish provider process identity.')
  }
  const startedAt = new Date(now()).toISOString()
  deps.onStarted?.({
    dispatchId: request.dispatchId,
    watchdogPid: process.pid,
    providerPid,
    processGroupId: platform === 'win32' ? null : providerPid,
    sentinelPath: request.sentinelPath
  })

  return new Promise((resolve, reject) => {
    let terminationTriggered = false
    let deadlineTriggered = false
    let shutdownTriggered = false
    let treeKillUnknown = false
    let forced = false
    let settled = false
    let cleanupTimer: WatchdogTimer | undefined
    let descendantSnapshotPromise: Promise<DescendantSnapshot | null> | null = null
    let latestDescendantSnapshot: DescendantSnapshot | null = null
    let descendantPollPromise: Promise<DescendantSnapshot | null> | null = null
    let descendantPollTimer: NodeJS.Timeout | undefined
    let descendantCleanupComplete = false
    let deferredClose: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null
    const signalSource = deps.signalSource ?? process
    const onShutdownSignal = () => triggerTermination('shutdown')

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return
      }
      settled = true
      clearTimer(deadlineTimer)
      if (cleanupTimer) {
        clearTimer(cleanupTimer)
      }
      if (descendantPollTimer) {
        clearInterval(descendantPollTimer)
      }
      signalSource.removeListener('SIGHUP', onShutdownSignal)
      signalSource.removeListener('SIGTERM', onShutdownSignal)
      signalSource.removeListener('SIGINT', onShutdownSignal)
      const sentinel: WorkerWatchdogSentinel = {
        dispatchId: request.dispatchId,
        startedAt,
        deadlineAt: request.deadlineAt,
        finishedAt: new Date(now()).toISOString(),
        exitCode,
        signal,
        stop: treeKillUnknown
          ? 'tree_kill_unknown'
          : shutdownTriggered
            ? 'shutdown'
            : platform === 'win32' && deadlineTriggered
              ? 'tree_kill'
              : forced
                ? 'kill'
                : deadlineTriggered
                  ? 'term'
                  : 'natural'
      }
      try {
        writeSentinel(request.sentinelPath, sentinel)
        resolve(sentinel)
      } catch (error) {
        reject(error)
      }
    }

    child.once('error', (error) => {
      signalSource.removeListener('SIGHUP', onShutdownSignal)
      signalSource.removeListener('SIGTERM', onShutdownSignal)
      signalSource.removeListener('SIGINT', onShutdownSignal)
      reject(error)
    })
    child.once('close', (exitCode, signal) => {
      if (
        terminationTriggered &&
        platform !== 'win32' &&
        sweepDetachedDescendants &&
        !descendantCleanupComplete
      ) {
        deferredClose = { exitCode, signal }
        return
      }
      if (!terminationTriggered && platform !== 'win32' && sweepDetachedDescendants) {
        // A POSIX parent exit reparents detached descendants before another PPID snapshot can
        // prove whether a child was created after the latest poll. Sweep every process we did
        // observe, but fail closed instead of publishing authoritative natural-exit evidence.
        treeKillUnknown = true
        void (async () => {
          const snapshot =
            (await descendantPollPromise?.catch(() => null)) ?? latestDescendantSnapshot
          if (terminationTriggered && !descendantCleanupComplete) {
            deferredClose = { exitCode, signal }
            return
          }
          if (!snapshot || snapshot.descendants.length === 0) {
            finish(exitCode, signal)
            return
          }
          treeKillUnknown ||= descendantSnapshotHasAmbiguousIdentity(snapshot)
          const signalled = await signalLiveDescendants(snapshot, 'SIGTERM').catch(() => 0)
          if (signalled === 0) {
            finish(exitCode, signal)
            return
          }
          cleanupTimer = setTimer(() => {
            void forceTerminateDescendants(snapshot)
              .catch(() => 0)
              .finally(() => finish(exitCode, signal))
          }, DESCENDANT_KILL_GRACE_MS)
        })()
        return
      }
      finish(exitCode, signal)
    })

    const terminateWindowsTreeSafely = async () => {
      const target = await verifyWindowsTreeKillTargetImpl(providerPid).catch(
        (): WindowsTreeKillTarget => 'unknown'
      )
      if (target === 'own') {
        treeKillUnknown = false
        await terminateWindowsTreeImpl(providerPid)
      } else {
        treeKillUnknown = true
      }
    }

    const triggerTermination = (reason: 'deadline' | 'shutdown') => {
      if (settled || terminationTriggered) {
        return
      }
      terminationTriggered = true
      deadlineTriggered = reason === 'deadline'
      shutdownTriggered = reason === 'shutdown'
      cleanupTimer = setTimer(() => {
        void (async () => {
          if (platform === 'win32') {
            forced = true
            await terminateWindowsTreeSafely()
            return
          }
          const snapshot = await descendantSnapshotPromise
          const forcedDescendants = snapshot
            ? await forceTerminateDescendants(snapshot).catch(() => 0)
            : 0
          if (!deferredClose) {
            forced = true
            try {
              killImpl(workerProcessGroupTarget(providerPid, platform), 'SIGKILL')
            } catch {
              // A raced close will settle the sentinel.
            }
          } else {
            forced = forcedDescendants > 0
          }
          descendantCleanupComplete = true
          if (deferredClose) {
            finish(deferredClose.exitCode, deferredClose.signal)
          }
        })()
      }, request.cleanupGraceMs)
      if (platform === 'win32') {
        void terminateWindowsTreeSafely()
      } else if (!sweepDetachedDescendants) {
        try {
          killImpl(workerProcessGroupTarget(providerPid, platform), 'SIGTERM')
        } catch {
          // The close event remains authoritative; a raced natural exit is safe.
        }
      } else {
        descendantSnapshotPromise = (async () => {
          try {
            killImpl(workerProcessGroupTarget(providerPid, platform), 'SIGSTOP')
          } catch {
            // A raced natural exit is handled by the close event.
          }
          const snapshot = await captureDescendants(providerPid).catch(() => null)
          if (snapshot) {
            treeKillUnknown ||= descendantSnapshotHasAmbiguousIdentity(snapshot)
            terminateDescendants(snapshot)
          }
          try {
            killImpl(workerProcessGroupTarget(providerPid, platform), 'SIGCONT')
          } catch {
            // The group may have exited while the descendant snapshot was captured.
          }
          try {
            killImpl(workerProcessGroupTarget(providerPid, platform), 'SIGTERM')
          } catch {
            // The close event remains authoritative; a raced natural exit is safe.
          }
          return snapshot
        })()
      }
    }
    if (platform !== 'win32' && sweepDetachedDescendants) {
      const poll = () => {
        if (settled || terminationTriggered || descendantPollPromise) {
          return
        }
        descendantPollPromise = captureDescendants(providerPid)
          .then((snapshot) => {
            latestDescendantSnapshot = snapshot
            return snapshot
          })
          .catch(() => null)
          .finally(() => {
            descendantPollPromise = null
          })
      }
      poll()
      descendantPollTimer = setInterval(poll, 500)
      descendantPollTimer.unref?.()
    }
    signalSource.once('SIGHUP', onShutdownSignal)
    signalSource.once('SIGTERM', onShutdownSignal)
    signalSource.once('SIGINT', onShutdownSignal)
    const deadlineDelay = Math.max(0, Date.parse(request.deadlineAt) - now())
    const deadlineTimer = setTimer(() => triggerTermination('deadline'), deadlineDelay)
    deadlineTimer.unref?.()
  })
}

if (require.main === module) {
  void runWorkerWatchdogEntry(runWorkerWatchdog).catch((error) => {
    process.stderr.write(
      `[worker-watchdog] ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exitCode = 1
  })
}
