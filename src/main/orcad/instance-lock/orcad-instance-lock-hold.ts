// Holding the lock means re-proving it on every heartbeat, not only at acquisition.
import { dirname } from 'node:path'
import { realpathSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { isDescendantOrEqualExact } from '../../filesystem/local-file-io/filesystem-path-containment'
import { startOrcadLockHeartbeat } from './orcad-lock-clone-machine'
import { readBoundedLockFile } from './orcad-instance-lock-reclaim'
import {
  describeLockHolder,
  parseOrcadInstanceLockRecord,
  type OrcadLockRecord
} from './orcad-instance-lock-record'
import type { OrcadUnexpectedExit } from '../../../shared/remote-runtime/orcad-lifecycle/orcad-unexpected-exit'

export type OrcadInstanceLock = {
  readonly path: string
  readonly record: OrcadLockRecord
  readonly previousUnexpectedExit: OrcadUnexpectedExit | null
  /** `keepUnexpectedExit` puts back the crashed run's record this lock reclaimed, so the next
   * start still reports that run; for one-shot tools that must not consume the notice. */
  release(options?: { keepUnexpectedExit?: boolean }): void
}

type OrcadProfileLock = {
  ownsProfile(): boolean
  onEnd(permit: Int32Array, stop: () => void): () => void
  confirmLoss(holder: OrcadLockRecord): void
}

const ownedProfileLocks = new Map<string, OrcadProfileLock>()

function canonicalDirectory(directory: string): string | undefined {
  try {
    return realpathSync.native(directory)
  } catch {
    return undefined
  }
}

export function findOrcadProfileLock(
  directory: string
): Pick<OrcadProfileLock, 'ownsProfile' | 'onEnd'> | undefined {
  if (ownedProfileLocks.size === 0) {
    return undefined
  }
  const canonical = canonicalDirectory(directory)
  let closest = ''
  for (const root of ownedProfileLocks.keys()) {
    if (canonical && root.length > closest.length && isDescendantOrEqualExact(canonical, root)) {
      closest = root
    }
  }
  return ownedProfileLocks.get(closest)
}

function lockIsAbsent(lockPath: string): boolean {
  try {
    return !statSync(lockPath, { throwIfNoEntry: false })
  } catch {
    // Unstattable (e.g. a Windows delete-pending file) proves nothing; the next beat retries.
    return false
  }
}

/** Re-assert ownership: a removed lock lets the next starter in, so re-publish it or yield to its new holder. */
function beatOrcadInstanceLock(
  lockPath: string,
  record: OrcadLockRecord,
  publish: () => boolean
): OrcadLockRecord | null {
  let current = readBoundedLockFile(lockPath)
  if (current === null && lockIsAbsent(lockPath)) {
    try {
      if (publish()) {
        console.warn(
          `[orcad] The instance lock ${lockPath} was removed while orcad ran; restored it.`
        )
        return null
      }
    } catch (error) {
      console.warn('[orcad] could not restore the removed instance lock:', error)
      return null
    }
    // Another starter published between the read and the restore.
    current = readBoundedLockFile(lockPath)
  }
  const holder = parseOrcadInstanceLockRecord(current ?? '')
  if (!holder) {
    // Starters refuse unreadable records, and torn ones show up as a new holder by the next beat.
    console.warn(`[orcad] could not read the instance lock ${lockPath} to confirm ownership`)
    return null
  }
  if (holder.nonce !== record.nonce) {
    return holder
  }
  try {
    const now = new Date()
    utimesSync(lockPath, now, now)
  } catch (error) {
    // A stalled heartbeat lets a machine sharing this machine-id take the lock.
    console.warn('[orcad] could not refresh the instance lock heartbeat:', error)
  }
  return null
}

export function holdOrcadInstanceLock(
  lockPath: string,
  record: OrcadLockRecord,
  publish: () => boolean,
  {
    previousUnexpectedExit,
    restoreReclaimedRecord,
    onExclusivityLost,
    profile
  }: {
    previousUnexpectedExit: OrcadUnexpectedExit | null
    /** Republishes the reclaimed record without overwriting a successor's lock. */
    restoreReclaimedRecord?: () => void
    onExclusivityLost: () => void
    profile: boolean
  }
): OrcadInstanceLock {
  const root = profile ? canonicalDirectory(dirname(lockPath)) : undefined
  const listeners = new Set<{ permit: Int32Array; stop: () => void }>()
  let released = false
  let ended = false
  const stopHeartbeat = startOrcadLockHeartbeat(() => {
    const holder = beatOrcadInstanceLock(lockPath, record, publish)
    if (holder) {
      held.confirmLoss(holder)
    }
  })
  const notify = (stop: () => void) => {
    try {
      stop()
    } catch (error) {
      console.warn('[orcad] instance lock listener failed:', error)
    }
  }
  const end = () => {
    ended = true
    for (const { permit } of listeners) {
      Atomics.store(permit, 0, 0)
    }
    stopHeartbeat()
    const stopped = [...listeners]
    listeners.clear()
    for (const { stop } of stopped) {
      notify(stop)
    }
  }
  const held: OrcadProfileLock = {
    ownsProfile: () => {
      if (ended) {
        return false
      }
      const holder = parseOrcadInstanceLockRecord(readBoundedLockFile(lockPath) ?? '')
      if (holder && holder.nonce !== record.nonce) {
        held.confirmLoss(holder)
        return false
      }
      return holder?.nonce === record.nonce && holder.pid === process.pid
    },
    onEnd: (permit, stop) => {
      if (ended) {
        Atomics.store(permit, 0, 0)
        notify(stop)
        return () => {}
      }
      const listener = { permit, stop }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    confirmLoss: (holder) => {
      if (ended) {
        return
      }
      end()
      console.error(
        `[orcad] ${describeLockHolder(holder)} (pid ${holder.pid}) took over the instance lock ` +
          `${lockPath}.`
      )
      notify(onExclusivityLost)
    }
  }
  if (root !== undefined) {
    const previous = ownedProfileLocks.get(root)
    ownedProfileLocks.set(root, held)
    previous?.confirmLoss(record)
  }
  return {
    path: lockPath,
    record,
    previousUnexpectedExit,
    release: (options) => {
      if (released) {
        return
      }
      released = true
      if (root !== undefined && ownedProfileLocks.get(root) === held) {
        ownedProfileLocks.delete(root)
      }
      end()
      // Re-read ownership before unlinking so a successor’s live runtime cannot be unlocked.
      const current = parseOrcadInstanceLockRecord(readBoundedLockFile(lockPath) ?? '')
      if (!current || current.nonce !== record.nonce) {
        return
      }
      try {
        unlinkSync(lockPath)
      } catch {
        // Dead-PID leftovers can be reclaimed on the next start.
      }
      if (options?.keepUnexpectedExit && previousUnexpectedExit) {
        restoreReclaimedRecord?.()
      }
    }
  }
}
