import {
  accessTokenOf,
  accessUsable,
  hasRefreshToken,
  oauthOf,
  ROTATION_JOURNAL_SERVICE_A,
  tokenHash,
  withOauth,
  type ClaudeAiOauth
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

/** Whether the first write of a cut-off swap landed in `a`, which is the login it holds now. */
async function firstWriteLanded(
  oauthA: ClaudeAiOauth,
  journal: RotationJournal,
  deps: RotationSwapDeps
): Promise<'yes' | 'no' | 'unknown'> {
  const hash = tokenHash(oauthA.refreshToken)
  if (hash === journal.aOldRefresh) {
    return 'no'
  }
  if (hash === journal.bOldRefresh) {
    return 'yes'
  }
  // Changed to neither: a Claude session in `a` refreshed whichever login it held.
  const token = accessTokenOf(oauthA)
  const who = token && accessUsable(oauthA, deps.now()) ? await deps.whoami(token) : null
  if (who !== null && who === journal.fromAccount) {
    return 'no'
  }
  return who !== null && who === journal.toAccount ? 'yes' : 'unknown'
}

/**
 * Finishes or cancels a swap cut off between its writes, so no login is dropped:
 * - `b` holds the old login of `a`: both writes landed.
 * - `a` still holds its own login: nothing was written.
 * - `a` holds the login of `b`, and `b` still holds it too or holds none: finish.
 * - `a` holds the login of `b`, but `b` refreshed it since: the copy in `a` is spent, so cancel.
 * Null when no swap is pending.
 */
export async function recoverInterruptedSwap(deps: RotationSwapDeps): Promise<string | null> {
  const journal = await deps.files.loadJournal()
  if (!journal || (journal.step !== 'begin' && journal.step !== 'a_written')) {
    return null
  }
  const a = journal.aFolder
  const b = journal.bFolder
  const lock = await refreshLock(deps, a, b)
  if (!(await lock.acquire(ROTATION_TIMING.lockWaitMs))) {
    return 'refresh_in_progress'
  }
  let result: string
  try {
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
      return await end('folder_gone')
    }
    if (hashB === journal.aOldRefresh) {
      result = 'already_finished'
    } else {
      const landed = await firstWriteLanded(oauthOf(slotA), journal, deps)
      if (landed === 'unknown') {
        return 'undecided'
      }
      if (landed === 'no') {
        return await end('nothing_written')
      }
      const saved = oauthOf(await deps.slots.read(ROTATION_JOURNAL_SERVICE_A))
      if (!hasRefreshToken(saved)) {
        return 'backup_missing'
      }
      if (hashB !== journal.bOldRefresh && hasRefreshToken(oauthB)) {
        if (!(await deps.slots.write(a.service, withOauth(slotA, saved)))) {
          return 'cancel_failed'
        }
        await nudgeRunningSessions(a)
        return await end('cancelled')
      }
      if (!(await deps.slots.write(b.service, withOauth(slotB, saved)))) {
        return 'second_write_failed'
      }
      result = 'finished'
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
