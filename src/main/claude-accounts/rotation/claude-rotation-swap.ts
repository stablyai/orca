import {
  hasRefreshToken,
  oauthOf,
  ROTATION_JOURNAL_SERVICE_A,
  ROTATION_JOURNAL_SERVICE_B,
  tokenHash,
  withOauth,
  type ClaudeKeychainSlot,
  type RotationSlotStore
} from './claude-rotation-keychain'
import { claudeRefreshLockPaths, RotationDirLock } from './claude-rotation-locks'
import {
  nudgeRunningSessions,
  oauthAccountForBackup,
  setLoginMeta,
  type RotationFolder
} from './claude-rotation-login-meta'
import { ROTATION_TIMING } from './claude-rotation-policy'
import type {
  RotationJournal,
  RotationStateFiles,
  RotationSwapKind
} from './claude-rotation-state-files'

export type RotationSwapDeps = {
  slots: RotationSlotStore
  files: RotationStateFiles
  /** First 8 characters of the account uuid the token belongs to; null when unknown. */
  whoami: (accessToken: string) => Promise<string | null>
  now: () => number
  sleep?: (ms: number) => Promise<void>
  /** Orca's records of the two folders' accounts, which follow the logins. */
  records?: {
    fingerprint: (accountId: string) => string | null
    /** Resolves once the exchange is on disk; false when it could not be saved. */
    exchange: (a: string, b: string) => Promise<boolean>
  }
}

export type RotationSwapRequest = {
  reason: string
  kind: RotationSwapKind
  fromAccount: string | null
  toAccount: string | null
}

/** What the decision to swap was based on, checked again once the locks are held. */
export type RotationSwapGuard = {
  /** Hashes of the refresh tokens the decision saw in `a` and `b`. */
  aRefresh: string
  bRefresh: string
  /** A reason to stop, or null to go on; runs under the locks, right before the first write. */
  beforeWrite: () => Promise<string | null>
}

export type RotationSwapResult =
  | { ok: true; journal: RotationJournal }
  | { ok: false; detail: string }

export async function refreshLock(
  deps: RotationSwapDeps,
  ...folders: RotationFolder[]
): Promise<RotationDirLock> {
  const paths: string[] = []
  for (const folder of folders) {
    paths.push(...(await claudeRefreshLockPaths(folder.home)))
  }
  return new RotationDirLock(paths, deps.sleep)
}

/**
 * Removes the journal before its backups: a failure part way must not leave a journal whose
 * backup is gone. Backups left without a journal are never read, and the next swap overwrites them.
 */
export async function clearRotationJournal(deps: RotationSwapDeps): Promise<void> {
  await deps.files.removeJournal()
  await deps.slots.remove(ROTATION_JOURNAL_SERVICE_A)
  await deps.slots.remove(ROTATION_JOURNAL_SERVICE_B)
}

function backupOf(slot: ClaudeKeychainSlot, oauthAccount: unknown): ClaudeKeychainSlot {
  return {
    claudeAiOauth: oauthOf(slot),
    ...(oauthAccount === undefined ? {} : { oauthAccount })
  }
}

/** Exchanges Orca's records only from the arrangement opposite to `want`, so repeats are harmless. */
async function placeRecords(
  journal: RotationJournal,
  want: 'swapped' | 'original',
  deps: RotationSwapDeps
): Promise<boolean> {
  const saved = journal.records
  if (!deps.records || !saved) {
    return true
  }
  const a = deps.records.fingerprint(journal.a)
  const b = deps.records.fingerprint(journal.b)
  const original = a === saved.a && b === saved.b
  const swapped = a === saved.b && b === saved.a
  if (want === 'swapped' ? original && !swapped : swapped && !original) {
    return deps.records.exchange(journal.a, journal.b)
  }
  return true
}

/** The account details and records are in place, so the journal is no longer needed for them. */
export function metaPlaced(meta: string | undefined): meta is string {
  return meta === 'ok' || meta === 'skipped_no_file'
}

/** Gives each folder the account details of the login it holds: swapped, or back as they were. */
export async function placeLoginMeta(
  journal: RotationJournal,
  want: 'swapped' | 'original',
  deps: RotationSwapDeps
): Promise<string> {
  let backupA: ClaudeKeychainSlot | null
  let backupB: ClaudeKeychainSlot | null
  try {
    backupA = await deps.slots.read(ROTATION_JOURNAL_SERVICE_A)
    backupB = await deps.slots.read(ROTATION_JOURNAL_SERVICE_B)
  } catch {
    return 'keychain_unavailable'
  }
  if (!backupA || !backupB) {
    return 'backup_missing'
  }
  const swapped = want === 'swapped'
  const meta = await setLoginMeta(
    journal.aFolder,
    journal.bFolder,
    swapped ? backupB.oauthAccount : backupA.oauthAccount,
    swapped ? backupA.oauthAccount : backupB.oauthAccount
  )
  if (!metaPlaced(meta)) {
    return meta
  }
  return (await placeRecords(journal, want, deps)) ? meta : 'records_unsaved'
}

/** Gives `a` the login of `b` and `b` the login of `a`; only `claudeAiOauth` moves. */
export async function swapFolderLogins(
  a: RotationFolder,
  b: RotationFolder,
  request: RotationSwapRequest,
  deps: RotationSwapDeps,
  guard?: RotationSwapGuard
): Promise<RotationSwapResult> {
  // An unreadable journal blocks too: overwriting it would drop the only copy of a login.
  if (await deps.files.journalExists()) {
    return { ok: false, detail: 'previous_swap_unverified' }
  }
  const lock = await refreshLock(deps, a, b)
  if (!(await lock.acquire(ROTATION_TIMING.lockWaitMs))) {
    return { ok: false, detail: 'refresh_in_progress' }
  }
  let wrote = false
  let journal: RotationJournal
  try {
    const slotA = await deps.slots.read(a.service)
    const slotB = await deps.slots.read(b.service)
    const oauthA = oauthOf(slotA)
    const oauthB = oauthOf(slotB)
    if (!slotA || !slotB || !hasRefreshToken(oauthA) || !hasRefreshToken(oauthB)) {
      return { ok: false, detail: 'missing_login' }
    }
    const aOldRefresh = tokenHash(oauthA.refreshToken)
    const bOldRefresh = tokenHash(oauthB.refreshToken)
    if (guard && (aOldRefresh !== guard.aRefresh || bOldRefresh !== guard.bRefresh)) {
      return { ok: false, detail: 'login_changed' }
    }
    const nextA = withOauth(slotA, oauthB)
    const nextB = withOauth(slotB, oauthA)
    let backupA: ClaudeKeychainSlot
    let backupB: ClaudeKeychainSlot
    try {
      backupA = backupOf(slotA, await oauthAccountForBackup(a))
      backupB = backupOf(slotB, await oauthAccountForBackup(b))
    } catch {
      return { ok: false, detail: 'meta_unreadable' }
    }
    const fits =
      deps.slots.fits(a.service, nextA) &&
      deps.slots.fits(b.service, nextB) &&
      deps.slots.fits(ROTATION_JOURNAL_SERVICE_A, backupA) &&
      deps.slots.fits(ROTATION_JOURNAL_SERVICE_B, backupB)
    if (!fits) {
      return { ok: false, detail: 'slot_too_large' }
    }
    const blocked = await guard?.beforeWrite()
    if (blocked) {
      return { ok: false, detail: blocked }
    }
    const backedUp =
      (await deps.slots.write(ROTATION_JOURNAL_SERVICE_A, backupA)) &&
      (await deps.slots.write(ROTATION_JOURNAL_SERVICE_B, backupB))
    if (!backedUp) {
      await clearRotationJournal(deps)
      return { ok: false, detail: 'backup_failed' }
    }
    journal = {
      at: deps.now(),
      a: a.accountId,
      b: b.accountId,
      aFolder: a,
      bFolder: b,
      step: 'begin',
      ...request,
      aOldRefresh,
      bOldRefresh,
      records: deps.records && {
        a: deps.records.fingerprint(a.accountId),
        b: deps.records.fingerprint(b.accountId)
      }
    }
    await deps.files.saveJournal(journal)
    wrote = true
    await lock.touch()
    if (!(await deps.slots.write(a.service, nextA))) {
      const restored = await deps.slots.write(a.service, slotA)
      if (restored) {
        await clearRotationJournal(deps)
      }
      deps.files.log('swap_failed', { at: 'a', restored, a: a.accountId, b: b.accountId })
      return {
        ok: false,
        detail: restored ? 'first_write_failed' : 'first_write_failed_recovering'
      }
    }
    journal.step = 'a_written'
    await deps.files.saveJournal(journal)
    await lock.touch()
    if (!(await deps.slots.write(b.service, nextB))) {
      const restored =
        (await deps.slots.write(a.service, slotA)) && (await deps.slots.write(b.service, slotB))
      if (restored) {
        await clearRotationJournal(deps)
      }
      deps.files.log('swap_failed', { at: 'b', restored, a: a.accountId, b: b.accountId })
      return {
        ok: false,
        detail: restored ? 'second_write_failed' : 'second_write_failed_recovering'
      }
    }
    journal.step = 'b_written'
    await deps.files.saveJournal(journal)
  } catch {
    return { ok: false, detail: wrote ? 'interrupted_recovering' : 'keychain_unavailable' }
  } finally {
    await lock.release()
    if (wrote) {
      await nudgeRunningSessions(a, b)
    }
  }
  journal.meta = await placeLoginMeta(journal, 'swapped', deps)
  await deps.files.saveJournal(journal)
  return { ok: true, journal }
}
