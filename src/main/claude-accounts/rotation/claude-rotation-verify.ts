import { nudgeRunningSessions } from './claude-rotation-login-meta'
import { ROTATION_TIMING } from './claude-rotation-policy'
import { clearIfUnchanged, settleFolders } from './claude-rotation-settle'
import type { RotationJournal } from './claude-rotation-state-files'
import {
  clearRotationJournal,
  metaPlaced,
  placeLoginMeta,
  type RotationSwapDeps
} from './claude-rotation-swap'

export type RotationVerifyOutcome =
  | 'ok'
  | 'reverted'
  | 'unexpected_account'
  | 'unchanged'
  | 'unverified'
  | 'waiting'

/**
 * After a swap, checks which account each folder holds. A session that wrote a login back over
 * either folder is settled first, so every account stays in one of them. The journal and its
 * backups stay until the account details match and both folders still hold what was checked.
 */
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
  const waiting = { outcome: 'waiting', journal } as const
  const logged = (outcome: RotationVerifyOutcome) => {
    deps.files.log('verify', { result: outcome, folder: journal.a, meta: journal.meta })
    return { outcome, journal }
  }
  const done = async (outcome: RotationVerifyOutcome) => {
    await clearRotationJournal(deps)
    return logged(outcome)
  }
  const gaveUp = age > ROTATION_TIMING.verifyGiveUpMs

  const settled = await settleFolders(journal, deps)
  if (settled.kind === 'busy') {
    return waiting
  }
  if (settled.kind === 'unexpected') {
    return done('unexpected_account')
  }
  if (settled.kind === 'unknown') {
    if (!gaveUp) {
      return waiting
    }
    return done(settled.aHash === journal.bOldRefresh ? 'unchanged' : 'unverified')
  }
  if (settled.wrote) {
    await nudgeRunningSessions(journal.aFolder, journal.bFolder)
  }
  // Placing is idempotent, so a pass after the folders changed places the details again.
  journal.meta = await placeLoginMeta(journal, settled.arrangement, deps)
  if (!metaPlaced(journal.meta) && !gaveUp) {
    await deps.files.saveJournal(journal)
    return waiting
  }
  // A session may have written a login back while the details were placed.
  if (!(await clearIfUnchanged(journal, settled.hashes, deps))) {
    return waiting
  }
  return logged(settled.arrangement === 'swapped' ? 'ok' : 'reverted')
}
