import { stat } from 'node:fs/promises'
import {
  accessTokenOf,
  accessUsable,
  hasRefreshToken,
  oauthOf,
  ROTATION_JOURNAL_SERVICE_A,
  ROTATION_JOURNAL_SERVICE_B,
  tokenHash,
  withOauth,
  type ClaudeAiOauth
} from './claude-rotation-keychain'
import type { RotationFolder } from './claude-rotation-login-meta'
import { ROTATION_TIMING } from './claude-rotation-policy'
import type { RotationJournal } from './claude-rotation-state-files'
import { clearRotationJournal, refreshLock, type RotationSwapDeps } from './claude-rotation-swap'

/** The account a login belongs to, as the server names it; null when its token cannot be used. */
async function accountHolding(
  oauth: ClaudeAiOauth,
  deps: Pick<RotationSwapDeps, 'whoami' | 'now'>
): Promise<string | null> {
  const token = accessTokenOf(oauth)
  return token && accessUsable(oauth, deps.now()) ? deps.whoami(token) : null
}

/** Removing an account from Orca deletes its folder and keychain item; nothing can go back. */
export async function folderGone(folder: RotationFolder): Promise<boolean> {
  return stat(folder.home).then(
    () => false,
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT'
  )
}

/**
 * The side of the swap a login belongs to: outgoing, incoming, neither (no login, or an account
 * the server names as a third one), or null when that cannot be told yet.
 */
type Side = 'from' | 'to' | 'other' | null

export async function sideOf(
  oauth: ClaudeAiOauth,
  journal: RotationJournal,
  deps: RotationSwapDeps
): Promise<Side> {
  if (!hasRefreshToken(oauth)) {
    return 'other'
  }
  const hash = tokenHash(oauth.refreshToken)
  if (hash === journal.aOldRefresh) {
    return 'from'
  }
  if (hash === journal.bOldRefresh) {
    return 'to'
  }
  const who = await accountHolding(oauth, deps)
  if (who === null || journal.fromAccount === null || journal.toAccount === null) {
    return null
  }
  return who === journal.fromAccount ? 'from' : who === journal.toAccount ? 'to' : 'other'
}

export type RotationSettlement =
  | {
      kind: 'settled'
      /** Whether `a` ends up with the incoming account or its own one back. */
      arrangement: 'swapped' | 'original'
      wrote: boolean
      /** The refresh-token hashes of `a` and `b` as settled, for the check before clearing. */
      hashes: [string, string]
    }
  | { kind: 'unknown'; aHash: string }
  | { kind: 'busy' }
  | { kind: 'unexpected' }
  | { kind: 'gone' }

/**
 * Reads both folders under their refresh locks so each account ends up in exactly one of them.
 * A running session can write a login back over either folder; when both then hold the same
 * account, the other one is only in its backup, so that backup goes back into a folder.
 */
export async function settleFolders(
  journal: RotationJournal,
  deps: RotationSwapDeps
): Promise<RotationSettlement> {
  const a = journal.aFolder
  const b = journal.bFolder
  // A folder removed with its account cannot be locked, and nothing can go back into it.
  if ((await folderGone(a)) || (await folderGone(b))) {
    return { kind: 'gone' }
  }
  const lock = await refreshLock(deps, a, b)
  if (!(await lock.acquire(ROTATION_TIMING.lockWaitMs))) {
    return { kind: 'busy' }
  }
  try {
    const slotA = await deps.slots.read(a.service)
    const slotB = await deps.slots.read(b.service)
    const hashA = tokenHash(oauthOf(slotA).refreshToken)
    const hashB = tokenHash(oauthOf(slotB).refreshToken)
    const inA = await sideOf(oauthOf(slotA), journal, deps)
    const inB = await sideOf(oauthOf(slotB), journal, deps)
    if (inA === 'other' || inB === 'other') {
      return { kind: 'unexpected' }
    }
    if (inA === null || inB === null) {
      return { kind: 'unknown', aHash: hashA }
    }
    if (inA !== inB) {
      const arrangement = inA === 'to' ? 'swapped' : 'original'
      return { kind: 'settled', arrangement, wrote: false, hashes: [hashA, hashB] }
    }
    // Once one folder refreshed the shared old login, the copy still on it is spent, so that
    // folder takes the backup. Otherwise `b` does, and `a` keeps what its sessions use.
    const stale = inA === 'from' ? journal.aOldRefresh : journal.bOldRefresh
    const intoA = hashA === stale && hashB !== stale
    const missing = inA === 'from' ? 'to' : 'from'
    const backup = oauthOf(
      await deps.slots.read(
        missing === 'to' ? ROTATION_JOURNAL_SERVICE_B : ROTATION_JOURNAL_SERVICE_A
      )
    )
    if (!hasRefreshToken(backup)) {
      return { kind: 'unexpected' }
    }
    const written = await deps.slots.write(
      intoA ? a.service : b.service,
      withOauth(intoA ? slotA : slotB, backup)
    )
    if (!written) {
      return { kind: 'busy' }
    }
    const restored = tokenHash(backup.refreshToken)
    return {
      kind: 'settled',
      arrangement: (intoA ? missing : inA) === 'to' ? 'swapped' : 'original',
      wrote: true,
      hashes: intoA ? [restored, hashB] : [hashA, restored]
    }
  } catch {
    return { kind: 'busy' }
  } finally {
    await lock.release()
  }
}

/** Clears the journal only while both folders still hold the logins settled, under their locks. */
export async function clearIfUnchanged(
  journal: RotationJournal,
  hashes: [string, string],
  deps: RotationSwapDeps
): Promise<boolean> {
  const lock = await refreshLock(deps, journal.aFolder, journal.bFolder)
  if (!(await lock.acquire(ROTATION_TIMING.lockWaitMs))) {
    return false
  }
  try {
    const now = [
      tokenHash(oauthOf(await deps.slots.read(journal.aFolder.service)).refreshToken),
      tokenHash(oauthOf(await deps.slots.read(journal.bFolder.service)).refreshToken)
    ]
    if (now[0] !== hashes[0] || now[1] !== hashes[1]) {
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
