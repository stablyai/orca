import {
  accessTokenOf,
  accessUsable,
  hasRefreshToken,
  oauthOf,
  ROTATION_JOURNAL_SERVICE_B,
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

export type RotationVerifyOutcome =
  | 'ok'
  | 'reverted'
  | 'revert_failed'
  | 'unexpected_account'
  | 'unchanged'
  | 'unverified'
  | 'waiting'

/** After a swap, checks that `a` still holds the incoming account; undoes an overwritten one. */
export async function verifySwap(
  deps: RotationSwapDeps,
  force = false
): Promise<{ outcome: RotationVerifyOutcome; journal: RotationJournal } | null> {
  const journal = await deps.files.loadJournal()
  if (!journal || journal.step !== 'b_written') {
    return null
  }
  const age = deps.now() - journal.at
  if (age < ROTATION_TIMING.verifyAfterMs && !force) {
    return null
  }
  const a = journal.aFolder
  const b = journal.bFolder
  const waiting = { outcome: 'waiting', journal } as const
  const done = async (outcome: RotationVerifyOutcome) => {
    await clearRotationJournal(deps)
    deps.files.log('verify', { result: outcome, folder: journal.a })
    return { outcome, journal }
  }
  let oauthA: Record<string, unknown>
  try {
    oauthA = oauthOf(await deps.slots.read(a.service))
  } catch {
    return waiting
  }
  // The outgoing session can write its old login back as it was; that needs no server answer.
  const wroteBack = tokenHash(oauthA.refreshToken) === journal.aOldRefresh
  const token = accessTokenOf(oauthA)
  const who =
    !wroteBack && token && accessUsable(oauthA, deps.now()) ? await deps.whoami(token) : null
  if (who !== null && who === journal.toAccount) {
    if (journal.meta !== 'ok' && journal.meta !== 'skipped_no_file') {
      journal.meta = await placeLoginMeta(journal, 'swapped', deps)
    }
    return done('ok')
  }
  if (wroteBack || (who !== null && who === journal.fromAccount)) {
    const reverted = await revertSecondSlot(journal, deps)
    if (reverted === 'retry') {
      // Clearing now would drop the backup, the only copy of the login of `b`.
      return waiting
    }
    if (reverted === 'reverted') {
      await placeLoginMeta(journal, 'original', deps)
    }
    await nudgeRunningSessions(a, b)
    return done(reverted === 'reverted' ? 'reverted' : 'revert_failed')
  }
  if (who !== null) {
    return done('unexpected_account')
  }
  if (age > ROTATION_TIMING.verifyGiveUpMs) {
    const intact = tokenHash(oauthA.refreshToken) === journal.bOldRefresh
    return done(intact ? 'unchanged' : 'unverified')
  }
  return waiting
}

/**
 * The outgoing account's login overwrote slot a; give `b` its own login back.
 * 'retry' when the locks or keychain were busy; 'impossible' when `b` changed since.
 */
async function revertSecondSlot(
  journal: RotationJournal,
  deps: RotationSwapDeps
): Promise<'reverted' | 'retry' | 'impossible'> {
  const lock = await refreshLock(deps, journal.aFolder, journal.bFolder)
  if (!(await lock.acquire(ROTATION_TIMING.lockWaitMs))) {
    return 'retry'
  }
  try {
    const service = journal.bFolder.service
    const slotB = await deps.slots.read(service)
    const saved = oauthOf(await deps.slots.read(ROTATION_JOURNAL_SERVICE_B))
    if (
      !slotB ||
      !hasRefreshToken(saved) ||
      tokenHash(oauthOf(slotB).refreshToken) !== journal.aOldRefresh
    ) {
      return 'impossible'
    }
    return (await deps.slots.write(service, withOauth(slotB, saved))) ? 'reverted' : 'retry'
  } catch {
    return 'retry'
  } finally {
    await lock.release()
  }
}
