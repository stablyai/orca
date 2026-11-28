import {
  hasRefreshToken,
  oauthOf,
  ROTATION_JOURNAL_SERVICE_A,
  tokenHash,
  withOauth
} from './claude-rotation-keychain'
import { nudgeRunningSessions } from './claude-rotation-login-meta'
import { ROTATION_TIMING } from './claude-rotation-policy'
import type { RotationJournal } from './claude-rotation-state-files'
import {
  clearRotationJournal,
  placeLoginMeta,
  refreshLock,
  type RotationSwapDeps
} from './claude-rotation-swap'
import { folderGone, sideOf } from './claude-rotation-settle'

/** Whether the first write of a cut-off swap landed in `a`, by the side of the login it holds. */
const LANDED = { from: 'no', to: 'yes', other: 'other' } as const

/** Decides a cut-off swap under the locks; the outcomes that end it clear the journal. */
async function settle(journal: RotationJournal, deps: RotationSwapDeps): Promise<string> {
  const a = journal.aFolder
  const b = journal.bFolder
  const slotA = await deps.slots.read(a.service)
  const slotB = await deps.slots.read(b.service)
  const oauthB = oauthOf(slotB)
  const hashB = tokenHash(oauthB.refreshToken)
  const end = async (outcome: string): Promise<string> => {
    await clearRotationJournal(deps)
    deps.files.log('recover', { result: outcome })
    return outcome
  }
  if (!slotA) {
    // The item of `a` was deleted with its account; nothing is left to put back there.
    return end('folder_gone')
  }
  if (hashB === journal.aOldRefresh) {
    return 'already_finished'
  }
  // Changed to neither old login: a Claude session in `a` refreshed whichever login it held.
  const inA = await sideOf(oauthOf(slotA), journal, deps)
  const landed = inA === null ? 'unknown' : LANDED[inA]
  if (landed === 'unknown') {
    return 'undecided'
  }
  if (landed === 'other') {
    return 'needs_repair'
  }
  const bChanged = hashB !== journal.bOldRefresh
  if (landed === 'no') {
    // A session in `a` can write its login back after both writes landed. `b` then holds the
    // login of `a`, and the only copy of its own is the backup, so the post-swap check settles it.
    const inB = bChanged ? await sideOf(oauthB, journal, deps) : 'to'
    if (inB === 'from') {
      return 'already_finished'
    }
    // No login or a third account in `b` may leave its own login only in the backup.
    return inB === null ? 'undecided' : inB === 'other' ? 'needs_repair' : end('nothing_written')
  }
  const saved = oauthOf(await deps.slots.read(ROTATION_JOURNAL_SERVICE_A))
  if (!hasRefreshToken(saved)) {
    return 'backup_missing'
  }
  if (bChanged && hasRefreshToken(oauthB)) {
    // `b` changed since: it refreshed the login the second write gave it, or its own.
    const inB = await sideOf(oauthB, journal, deps)
    if (inB !== 'to') {
      return inB === 'from' ? 'already_finished' : inB === null ? 'undecided' : 'needs_repair'
    }
    // `b` refreshed its own login, so the copy in `a` is spent: give `a` its login back.
    if (!(await deps.slots.write(a.service, withOauth(slotA, saved)))) {
      return 'cancel_failed'
    }
    await nudgeRunningSessions(a)
    return end('cancelled')
  }
  if (!(await deps.slots.write(b.service, withOauth(slotB, saved)))) {
    return 'second_write_failed'
  }
  return 'finished'
}

/**
 * Finishes or cancels a swap cut off between its writes, so no login is dropped:
 * - `b` holds the old login of `a`, or the server names its account as `a`'s: both writes landed.
 * - `a` still holds its own login: nothing was written.
 * - `a` holds the login of `b`, and `b` still holds it too or holds none: finish.
 * - `a` holds the login of `b`, but `b` refreshed it since: the copy in `a` is spent, so cancel.
 * - Anything the server cannot settle keeps the journal and its backups.
 * - No login or a third account where one of the two should be also keeps them, and returns
 *   'needs_repair' the first time so the user can be told; switching waits until it is fixed.
 * Null when no swap is pending.
 */
export async function recoverInterruptedSwap(deps: RotationSwapDeps): Promise<string | null> {
  const result = await recover(deps)
  if (result) {
    deps.files.log('recover_cycle', { result })
  }
  return result
}

async function recover(deps: RotationSwapDeps): Promise<string | null> {
  const journal = await deps.files.loadJournal()
  if (!journal || (journal.step !== 'begin' && journal.step !== 'a_written')) {
    return null
  }
  const a = journal.aFolder
  const b = journal.bFolder
  // A folder removed with its account cannot be locked, and nothing can go back into it.
  if ((await folderGone(a)) || (await folderGone(b))) {
    await clearRotationJournal(deps)
    deps.files.log('recover', { result: 'folder_gone' })
    return 'folder_gone'
  }
  const lock = await refreshLock(deps, a, b)
  if (!(await lock.acquire(ROTATION_TIMING.lockWaitMs))) {
    return 'refresh_in_progress'
  }
  let result: string
  try {
    result = await settle(journal, deps)
    if (result === 'needs_repair') {
      if (journal.needsRepair) {
        return 'repair_waiting'
      }
      journal.needsRepair = true
      await deps.files.saveJournal(journal)
      return result
    }
    if (result !== 'finished' && result !== 'already_finished') {
      return result
    }
    journal.step = 'b_written'
    await deps.files.saveJournal(journal)
  } catch {
    return 'keychain_unavailable'
  } finally {
    await lock.release()
  }
  if (journal.meta === undefined) {
    journal.meta = await placeLoginMeta(journal, 'swapped', deps)
    await deps.files.saveJournal(journal)
  }
  await nudgeRunningSessions(a, b)
  deps.files.log('recover', { result })
  return result
}
