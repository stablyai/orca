import {
  accessTokenOf,
  accessUsable,
  hasRefreshToken,
  oauthOf,
  ROTATION_JOURNAL_SERVICE_A,
  ROTATION_JOURNAL_SERVICE_B,
  tokenHash,
  withOauth,
  type RotationSlotStore
} from './claude-rotation-keychain'
import { claudeRefreshLockPaths, RotationDirLock } from './claude-rotation-locks'
import {
  nudgeRunningSessions,
  swapLoginMeta,
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
  /** Called whenever two folders' account details trade places, so Orca's records can follow. */
  onMetaSwapped?: (a: string, b: string) => void
}

export type RotationSwapRequest = {
  reason: string
  kind: RotationSwapKind
  fromAccount: string | null
  toAccount: string | null
}

export type RotationSwapResult =
  | { ok: true; journal: RotationJournal }
  | { ok: false; detail: string }

export function refreshLock(deps: RotationSwapDeps, ...folders: RotationFolder[]): RotationDirLock {
  return new RotationDirLock(
    folders.flatMap((folder) => claudeRefreshLockPaths(folder.home)),
    deps.sleep
  )
}

export async function swapMeta(
  a: RotationFolder,
  b: RotationFolder,
  deps: RotationSwapDeps
): Promise<string> {
  const meta = await swapLoginMeta(a, b)
  if (meta === 'ok') {
    deps.onMetaSwapped?.(a.accountId, b.accountId)
  }
  return meta
}

export async function clearRotationJournal(deps: RotationSwapDeps): Promise<void> {
  await deps.slots.remove(ROTATION_JOURNAL_SERVICE_A)
  await deps.slots.remove(ROTATION_JOURNAL_SERVICE_B)
  deps.files.removeJournal()
}

/** Gives `a` the login of `b` and `b` the login of `a`; only `claudeAiOauth` moves. */
export async function swapFolderLogins(
  a: RotationFolder,
  b: RotationFolder,
  request: RotationSwapRequest,
  deps: RotationSwapDeps
): Promise<RotationSwapResult> {
  if (deps.files.loadJournal()) {
    return { ok: false, detail: 'previous_swap_unverified' }
  }
  const lock = refreshLock(deps, a, b)
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
    const nextA = withOauth(slotA, oauthB)
    const nextB = withOauth(slotB, oauthA)
    if (!deps.slots.fits(a.service, nextA) || !deps.slots.fits(b.service, nextB)) {
      return { ok: false, detail: 'slot_too_large' }
    }
    const backedUp =
      (await deps.slots.write(ROTATION_JOURNAL_SERVICE_A, { claudeAiOauth: oauthA })) &&
      (await deps.slots.write(ROTATION_JOURNAL_SERVICE_B, { claudeAiOauth: oauthB }))
    if (!backedUp) {
      await clearRotationJournal(deps)
      return { ok: false, detail: 'backup_failed' }
    }
    journal = {
      at: deps.now(),
      a: a.accountId,
      b: b.accountId,
      step: 'begin',
      ...request,
      aOldRefresh: tokenHash(oauthA.refreshToken),
      bOldRefresh: tokenHash(oauthB.refreshToken)
    }
    deps.files.saveJournal(journal)
    wrote = true
    lock.touch()
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
    deps.files.saveJournal(journal)
    lock.touch()
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
    deps.files.saveJournal(journal)
  } catch {
    return { ok: false, detail: wrote ? 'interrupted_recovering' : 'keychain_unavailable' }
  } finally {
    lock.release()
    if (wrote) {
      nudgeRunningSessions(a, b)
    }
  }
  journal.meta = await swapMeta(a, b, deps)
  deps.files.saveJournal(journal)
  return { ok: true, journal }
}

/** Finishes or cancels a swap cut off between its two writes. Null when none is pending. */
export async function recoverInterruptedSwap(
  folders: Map<string, RotationFolder>,
  deps: RotationSwapDeps
): Promise<string | null> {
  const journal = deps.files.loadJournal()
  if (!journal || (journal.step !== 'begin' && journal.step !== 'a_written')) {
    return null
  }
  const a = folders.get(journal.a)
  const b = folders.get(journal.b)
  if (!a || !b) {
    return 'folder_missing'
  }
  const lock = refreshLock(deps, a, b)
  if (!(await lock.acquire(ROTATION_TIMING.lockWaitMs))) {
    return 'refresh_in_progress'
  }
  let result: string
  try {
    const slotB = await deps.slots.read(b.service)
    const oauthA = oauthOf(await deps.slots.read(a.service))
    const hashA = tokenHash(oauthA.refreshToken)
    if (tokenHash(oauthOf(slotB).refreshToken) !== journal.bOldRefresh) {
      result = 'already_finished'
    } else if (hashA === journal.aOldRefresh) {
      await clearRotationJournal(deps)
      deps.files.log('recover', { result: 'nothing_written' })
      return 'nothing_written'
    } else {
      // Slot a changed: either the swap wrote it, or Claude refreshed the original login.
      let written = hashA === journal.bOldRefresh
      const token = accessTokenOf(oauthA)
      if (!written && token && accessUsable(oauthA, deps.now())) {
        const who = await deps.whoami(token)
        if (who !== null && who === journal.fromAccount) {
          await clearRotationJournal(deps)
          deps.files.log('recover', { result: 'original_refreshed' })
          return 'original_refreshed'
        }
        written = who !== null && who === journal.toAccount
      }
      if (!written) {
        return 'undecided'
      }
      const saved = oauthOf(await deps.slots.read(ROTATION_JOURNAL_SERVICE_A))
      if (!hasRefreshToken(saved)) {
        return 'backup_missing'
      }
      if (!(await deps.slots.write(b.service, withOauth(slotB, saved)))) {
        return 'second_write_failed'
      }
      result = 'finished'
    }
    journal.step = 'b_written'
    deps.files.saveJournal(journal)
  } catch {
    return 'keychain_unavailable'
  } finally {
    lock.release()
  }
  if (journal.meta === undefined) {
    journal.meta = await swapMeta(a, b, deps)
    deps.files.saveJournal(journal)
  }
  nudgeRunningSessions(a, b)
  deps.files.log('recover', { result })
  return result
}
