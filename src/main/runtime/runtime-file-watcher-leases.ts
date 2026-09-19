// @ts-nocheck -- mechanically split declarations.
import type { RuntimeFileWatcherLease } from './runtime-file-commands-mobile-file-list-limit'
import {
  pendingRuntimeFileWatcherUnsubscribes,
  runtimeFileWatcherLeasesByOwnerAndRoot,
  runtimeWatcherReleaseKey,
  sshFileExplorerWatchRearms,
  trackRuntimeFileWatcherUnsubscribe
} from './runtime-file-commands-mobile-file-list-limit'
import { isWatcherProcessFailure } from '../ipc/parcel-watcher-process-failure'
import { stopSshFileExplorerWatchRearms } from './runtime-file-commands-ssh-file-watcher-rearm'

export function registerRuntimeFileWatcherRelease(
  runtimeId: string,
  connectionId: string | undefined,
  rootPaths: string[],
  unsubscribe: () => Promise<void>,
  restart: () => Promise<() => Promise<void>>,
  onRestoreError: (error: Error) => void
): () => Promise<void> {
  const keys = Array.from(
    new Set(
      rootPaths.map((rootPath) => runtimeWatcherReleaseKey(runtimeId, connectionId, rootPath))
    )
  )
  let currentUnsubscribe: (() => Promise<void>) | null = unsubscribe
  let releasePromise: Promise<void> | null = null
  let physicalExitPromise: Promise<void> | null = null
  let resumePromise: Promise<void> | null = null
  let stopPromise: Promise<void> | null = null
  let logicallyStopped = false
  const removeLease = (): void => {
    for (const key of keys) {
      const leases = runtimeFileWatcherLeasesByOwnerAndRoot.get(key)
      leases?.delete(lease)
      if (leases?.size === 0) {
        runtimeFileWatcherLeasesByOwnerAndRoot.delete(key)
      }
    }
  }
  const suspend = (): Promise<void> => {
    if (releasePromise) {
      return releasePromise
    }
    const release = currentUnsubscribe
    if (!release) {
      return Promise.resolve()
    }
    const attempt = trackRuntimeFileWatcherUnsubscribe(rootPaths[0], release)
    releasePromise = attempt
    void attempt.then(
      () => {
        if (currentUnsubscribe === release) {
          currentUnsubscribe = null
        }
        releasePromise = null
      },
      (error: unknown) => {
        if (isWatcherProcessFailure(error) && error.physicalExit) {
          const physicalExit = error.physicalExit.then(() => {
            if (currentUnsubscribe === release) {
              currentUnsubscribe = null
            }
            releasePromise = null
            if (physicalExitPromise === physicalExit) {
              physicalExitPromise = null
            }
            if (logicallyStopped) {
              removeLease()
            }
          })
          physicalExitPromise = physicalExit
        } else {
          // Why: a synchronous close failure retains the native owner so a later removal or unsubscribe can retry the same handle.
          releasePromise = null
        }
      }
    )
    return attempt
  }
  const lease: RuntimeFileWatcherLease = {
    suspend,
    resume: () => {
      if (logicallyStopped || (currentUnsubscribe && !physicalExitPromise)) {
        return Promise.resolve()
      }
      if (resumePromise) {
        return physicalExitPromise ? Promise.resolve() : resumePromise
      }
      // Why: a timed-out child still owns native handles until physical exit; join that owner before starting a replacement.
      const resumesAfterPhysicalExit = physicalExitPromise !== null
      const attempt = Promise.resolve(physicalExitPromise ?? releasePromise)
        .then(async () => {
          if (logicallyStopped) {
            return
          }
          const nextUnsubscribe = await restart()
          if (logicallyStopped) {
            await nextUnsubscribe()
            return
          }
          currentUnsubscribe = nextUnsubscribe
        })
        .catch((error: unknown) => {
          const restoreError = error instanceof Error ? error : new Error(String(error))
          queueMicrotask(() => onRestoreError(restoreError))
          throw restoreError
        })
        .finally(() => {
          resumePromise = null
        })
      resumePromise = attempt
      if (resumesAfterPhysicalExit) {
        void attempt.catch(() => {})
        return Promise.resolve()
      }
      return attempt
    },
    forget: () => {
      logicallyStopped = true
      removeLease()
    }
  }
  for (const key of keys) {
    const leases = runtimeFileWatcherLeasesByOwnerAndRoot.get(key) ?? new Set()
    leases.add(lease)
    runtimeFileWatcherLeasesByOwnerAndRoot.set(key, leases)
  }
  return () => {
    if (stopPromise) {
      return stopPromise
    }
    logicallyStopped = true
    const release =
      resumePromise && !physicalExitPromise
        ? Promise.resolve(resumePromise)
            .catch(() => undefined)
            .then(suspend)
        : suspend()
    const attempt = release.then(removeLease).catch((error: unknown) => {
      stopPromise = null
      throw error
    })
    stopPromise = attempt
    return attempt
  }
}

export async function awaitRuntimeFileWatcherUnsubscribes(): Promise<void> {
  await Promise.allSettled(Array.from(pendingRuntimeFileWatcherUnsubscribes))
}

export function _getRuntimeFileWatcherReleaseCountForTests(): number {
  const leases = new Set<RuntimeFileWatcherLease>()
  for (const rootLeases of runtimeFileWatcherLeasesByOwnerAndRoot.values()) {
    for (const lease of rootLeases) {
      leases.add(lease)
    }
  }
  return leases.size
}

export function _resetRuntimeFileWatcherLeasesForTests(): void {
  const leases = new Set<RuntimeFileWatcherLease>()
  for (const rootLeases of runtimeFileWatcherLeasesByOwnerAndRoot.values()) {
    for (const lease of rootLeases) {
      leases.add(lease)
    }
  }
  for (const lease of leases) {
    lease.forget()
  }
  for (const key of Array.from(sshFileExplorerWatchRearms.keys())) {
    stopSshFileExplorerWatchRearms(key)
  }
  runtimeFileWatcherLeasesByOwnerAndRoot.clear()
}
