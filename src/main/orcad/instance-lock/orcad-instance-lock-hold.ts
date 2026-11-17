// Holding the lock means re-proving it on every heartbeat, not only at acquisition.
import { statSync, unlinkSync, utimesSync } from 'node:fs'
import { startOrcadLockHeartbeat } from './orcad-lock-clone-machine'
import { readBoundedLockFile } from './orcad-instance-lock-reclaim'
import {
  describeLockHolder,
  parseOrcadInstanceLockRecord,
  type OrcadLockRecord
} from './orcad-instance-lock-record'
import type { OrcadUnexpectedExit } from '../../../shared/orcad-unexpected-exit'

export type OrcadInstanceLock = {
  readonly path: string
  readonly record: OrcadLockRecord
  readonly previousUnexpectedExit: OrcadUnexpectedExit | null
  /** `keepUnexpectedExit` puts back the crashed run's record this lock reclaimed, so the next
   * start still reports that run; for one-shot tools that must not consume the notice. */
  release(options?: { keepUnexpectedExit?: boolean }): void
}

type OrcadLockBeat = 'held' | 'lost' | 'unproven'

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
): OrcadLockBeat {
  let current = readBoundedLockFile(lockPath)
  if (current === null && lockIsAbsent(lockPath)) {
    try {
      if (publish()) {
        console.warn(
          `[orcad] The instance lock ${lockPath} was removed while orcad ran; restored it.`
        )
        return 'held'
      }
    } catch (error) {
      console.warn('[orcad] could not restore the removed instance lock:', error)
      return 'unproven'
    }
    // Another starter published between the read and the restore.
    current = readBoundedLockFile(lockPath)
  }
  const holder = parseOrcadInstanceLockRecord(current ?? '')
  if (!holder) {
    // Starters refuse unreadable records, and torn ones show up as a new holder by the next beat.
    console.warn(`[orcad] could not read the instance lock ${lockPath} to confirm ownership`)
    return 'unproven'
  }
  if (holder.nonce !== record.nonce) {
    console.error(
      `[orcad] ${describeLockHolder(holder)} (pid ${holder.pid}) took over the instance lock ` +
        `${lockPath}.`
    )
    return 'lost'
  }
  try {
    const now = new Date()
    utimesSync(lockPath, now, now)
  } catch (error) {
    // A stalled heartbeat lets a machine sharing this machine-id take the lock.
    console.warn('[orcad] could not refresh the instance lock heartbeat:', error)
  }
  return 'held'
}

export function holdOrcadInstanceLock(
  lockPath: string,
  record: OrcadLockRecord,
  publish: () => boolean,
  {
    previousUnexpectedExit,
    restoreReclaimedRecord,
    onExclusivityLost
  }: {
    previousUnexpectedExit: OrcadUnexpectedExit | null
    /** Republishes the reclaimed record without overwriting a successor's lock. */
    restoreReclaimedRecord?: () => void
    onExclusivityLost: () => void
  }
): OrcadInstanceLock {
  let released = false
  const stopHeartbeat = startOrcadLockHeartbeat(() => {
    if (beatOrcadInstanceLock(lockPath, record, publish) === 'lost') {
      stopHeartbeat()
      onExclusivityLost()
    }
  })
  return {
    path: lockPath,
    record,
    previousUnexpectedExit,
    release: (options) => {
      if (released) {
        return
      }
      released = true
      stopHeartbeat()
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
