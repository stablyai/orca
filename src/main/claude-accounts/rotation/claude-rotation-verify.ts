import {
  accessTokenOf,
  accessUsable,
  hasRefreshToken,
  oauthOf,
  ROTATION_JOURNAL_SERVICE_B,
  tokenHash,
  withOauth
} from './claude-rotation-keychain'
import { nudgeRunningSessions, type RotationFolder } from './claude-rotation-login-meta'
import { ROTATION_TIMING } from './claude-rotation-policy'
import type { RotationJournal } from './claude-rotation-state-files'
import {
  clearRotationJournal,
  refreshLock,
  swapMeta,
  type RotationSwapDeps
} from './claude-rotation-swap'

export type RotationVerifyOutcome =
  | 'ok'
  | 'reverted'
  | 'revert_failed'
  | 'unexpected_account'
  | 'unchanged'
  | 'unverified'
  | 'folder_missing'
  | 'waiting'

/** After a swap, checks that `a` still holds the incoming account; undoes an overwritten one. */
export async function verifySwap(
  folders: Map<string, RotationFolder>,
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
  const a = folders.get(journal.a)
  const b = folders.get(journal.b)
  const done = async (outcome: RotationVerifyOutcome) => {
    await clearRotationJournal(deps)
    deps.files.log('verify', { result: outcome, folder: journal.a })
    return { outcome, journal }
  }
  if (!a || !b) {
    return done('folder_missing')
  }
  let oauthA: Record<string, unknown>
  try {
    oauthA = oauthOf(await deps.slots.read(a.service))
  } catch {
    return { outcome: 'waiting', journal }
  }
  const token = accessTokenOf(oauthA)
  const who = token && accessUsable(oauthA, deps.now()) ? await deps.whoami(token) : null
  if (who !== null && who === journal.toAccount) {
    if (journal.meta !== 'ok' && journal.meta !== 'skipped_no_file') {
      journal.meta = await swapMeta(a, b, deps)
    }
    return done('ok')
  }
  if (who !== null && who === journal.fromAccount) {
    const reverted = await revertSecondSlot(a, b, journal, deps)
    if (reverted && journal.meta === 'ok') {
      await swapMeta(a, b, deps)
    }
    await nudgeRunningSessions(a, b)
    return done(reverted ? 'reverted' : 'revert_failed')
  }
  if (who !== null) {
    return done('unexpected_account')
  }
  if (age > ROTATION_TIMING.verifyGiveUpMs) {
    const intact = tokenHash(oauthA.refreshToken) === journal.bOldRefresh
    return done(intact ? 'unchanged' : 'unverified')
  }
  return { outcome: 'waiting', journal }
}

/** The outgoing account's refresh overwrote slot a; give `b` its own login back. */
async function revertSecondSlot(
  a: RotationFolder,
  b: RotationFolder,
  journal: RotationJournal,
  deps: RotationSwapDeps
): Promise<boolean> {
  const lock = await refreshLock(deps, a, b)
  if (!(await lock.acquire(ROTATION_TIMING.lockWaitMs))) {
    return false
  }
  try {
    const slotB = await deps.slots.read(b.service)
    const saved = oauthOf(await deps.slots.read(ROTATION_JOURNAL_SERVICE_B))
    if (
      !slotB ||
      !hasRefreshToken(saved) ||
      tokenHash(oauthOf(slotB).refreshToken) !== journal.aOldRefresh
    ) {
      return false
    }
    return await deps.slots.write(b.service, withOauth(slotB, saved))
  } catch {
    return false
  } finally {
    await lock.release()
  }
}
