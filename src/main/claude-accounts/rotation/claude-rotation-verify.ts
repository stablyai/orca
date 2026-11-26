import {
  accessTokenOf,
  accessUsable,
  hasRefreshToken,
  oauthOf,
  ROTATION_JOURNAL_SERVICE_B,
  tokenHash,
  withOauth,
  type ClaudeAiOauth
} from './claude-rotation-keychain'
import { nudgeRunningSessions } from './claude-rotation-login-meta'
import { ROTATION_TIMING } from './claude-rotation-policy'
import type { RotationJournal } from './claude-rotation-state-files'
import {
  clearRotationJournal,
  metaPlaced,
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

/** The account a login belongs to, as the server names it; null when its token cannot be used. */
export async function accountHolding(
  oauth: ClaudeAiOauth,
  deps: Pick<RotationSwapDeps, 'whoami' | 'now'>
): Promise<string | null> {
  const token = accessTokenOf(oauth)
  return token && accessUsable(oauth, deps.now()) ? deps.whoami(token) : null
}

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
  const logged = (outcome: RotationVerifyOutcome) => {
    deps.files.log('verify', { result: outcome, folder: journal.a, meta: journal.meta })
    return { outcome, journal }
  }
  const done = async (outcome: RotationVerifyOutcome) => {
    await clearRotationJournal(deps)
    return logged(outcome)
  }
  // The backups carry the account details, so the journal stays until those are in place.
  const settled = async (meta: string): Promise<boolean> => {
    journal.meta = meta
    if (metaPlaced(meta) || age > ROTATION_TIMING.verifyGiveUpMs) {
      return true
    }
    await deps.files.saveJournal(journal)
    return false
  }
  const finishRevert = async () =>
    (await settled(await placeLoginMeta(journal, 'original', deps))) ? done('reverted') : waiting

  if (journal.reverted) {
    return finishRevert()
  }
  let oauthA: ClaudeAiOauth
  try {
    oauthA = oauthOf(await deps.slots.read(a.service))
  } catch {
    return waiting
  }
  const seen = tokenHash(oauthA.refreshToken)
  // The outgoing session can write its old login back as it was; that needs no server answer.
  const wroteBack = seen === journal.aOldRefresh
  const who = wroteBack ? null : await accountHolding(oauthA, deps)
  if (who !== null && who === journal.toAccount) {
    const meta = metaPlaced(journal.meta)
      ? journal.meta
      : await placeLoginMeta(journal, 'swapped', deps)
    if (!(await settled(meta))) {
      return waiting
    }
    // The outgoing session may have written its old login back during the lookup.
    return (await clearIfUnchanged(journal, seen, deps)) ? logged('ok') : waiting
  }
  if (wroteBack || (who !== null && who === journal.fromAccount)) {
    const reverted = await revertSecondSlot(journal, deps)
    if (reverted === 'retry') {
      // Clearing now would drop the backup, the only copy of the login of `b`.
      return waiting
    }
    if (reverted === 'impossible') {
      return done('revert_failed')
    }
    journal.reverted = true
    await deps.files.saveJournal(journal)
    if (reverted === 'reverted') {
      await nudgeRunningSessions(a, b)
    }
    return finishRevert()
  }
  if (who !== null) {
    return done('unexpected_account')
  }
  if (age > ROTATION_TIMING.verifyGiveUpMs) {
    return done(seen === journal.bOldRefresh ? 'unchanged' : 'unverified')
  }
  return waiting
}

/** Clears the journal only while `a` still holds the login checked, under its refresh lock. */
async function clearIfUnchanged(
  journal: RotationJournal,
  seen: string,
  deps: RotationSwapDeps
): Promise<boolean> {
  const lock = await refreshLock(deps, journal.aFolder)
  if (!(await lock.acquire(ROTATION_TIMING.lockWaitMs))) {
    return false
  }
  try {
    if (tokenHash(oauthOf(await deps.slots.read(journal.aFolder.service)).refreshToken) !== seen) {
      return false
    }
    await clearRotationJournal(deps)
    return true
  } catch {
    return false
  } finally {
    await lock.release()
  }
}

/**
 * The outgoing account's login overwrote slot a; give `b` its own login back.
 * 'already' when an earlier pass did; 'retry' when the locks or keychain were busy;
 * 'impossible' when `b` changed since.
 */
async function revertSecondSlot(
  journal: RotationJournal,
  deps: RotationSwapDeps
): Promise<'reverted' | 'already' | 'retry' | 'impossible'> {
  const lock = await refreshLock(deps, journal.aFolder, journal.bFolder)
  if (!(await lock.acquire(ROTATION_TIMING.lockWaitMs))) {
    return 'retry'
  }
  try {
    const service = journal.bFolder.service
    const slotB = await deps.slots.read(service)
    const held = tokenHash(oauthOf(slotB).refreshToken)
    if (held === journal.bOldRefresh) {
      // Only this rollback writes that login back, so a pass that stopped after it did.
      return 'already'
    }
    const saved = oauthOf(await deps.slots.read(ROTATION_JOURNAL_SERVICE_B))
    if (!slotB || !hasRefreshToken(saved) || held !== journal.aOldRefresh) {
      return 'impossible'
    }
    return (await deps.slots.write(service, withOauth(slotB, saved))) ? 'reverted' : 'retry'
  } catch {
    return 'retry'
  } finally {
    await lock.release()
  }
}
