import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

/**
 * Claude PTYs launched with `--account` on a managed account that is not the host's active one.
 *
 * Kept apart from live-pty-gate's global set on purpose: that set defers the ACTIVE account's
 * refresh and read-back, which a pinned PTY never touches. A pinned PTY guards its own account
 * instead — no host switch to it, no removal, no Orca-side token refresh — for as long as a
 * Claude it launched may still hold that account's single-use refresh token.
 */
const accountIdByPtyId = new Map<string, string>()
// Why: restored at startup but not yet confirmed against the daemon; they keep the account
// guarded so a restart cannot refresh a token a surviving pinned Claude still owns.
const seededUnconfirmedPtyIds = new Set<string>()
// Why: a launch holds its account from auth preparation until the PTY is registered, so a host
// switch cannot land between the credential seed and the spawn.
const reservationsByAccountId = new Map<string, number>()
const drainListeners = new Set<(accountId: string) => void>()

export type ClaudePinnedPtyPersistence = {
  write(entries: Record<string, string>): void
}

let persistence: ClaudePinnedPtyPersistence | null = null

export function attachClaudePinnedPtyPersistence(target: ClaudePinnedPtyPersistence | null): void {
  persistence = target
}

/** Fires when an account's last pinned PTY exits and no launch still holds it. */
export function onClaudePinnedAccountDrained(listener: (accountId: string) => void): () => void {
  drainListeners.add(listener)
  return () => drainListeners.delete(listener)
}

export function countClaudePinnedAccountUsers(accountId: string): number {
  let count = reservationsByAccountId.get(accountId) ?? 0
  for (const pinnedAccountId of accountIdByPtyId.values()) {
    if (pinnedAccountId === accountId) {
      count += 1
    }
  }
  return count
}

export function hasLivePinnedClaudePtys(accountId: string): boolean {
  for (const pinnedAccountId of accountIdByPtyId.values()) {
    if (pinnedAccountId === accountId) {
      return true
    }
  }
  return false
}

/** Held from auth preparation until the spawn settles; each reserve needs exactly one release. */
export function reserveClaudePinnedAccount(accountId: string): void {
  reservationsByAccountId.set(accountId, (reservationsByAccountId.get(accountId) ?? 0) + 1)
}

export function releaseClaudePinnedAccountReservation(accountId: string): void {
  const remaining = (reservationsByAccountId.get(accountId) ?? 0) - 1
  if (remaining > 0) {
    reservationsByAccountId.set(accountId, remaining)
  } else {
    reservationsByAccountId.delete(accountId)
  }
  notifyIfDrained(accountId)
}

export function markPinnedClaudePtySpawned(ptyId: string, accountId: string): void {
  accountIdByPtyId.set(ptyId, accountId)
  seededUnconfirmedPtyIds.delete(ptyId)
  persist()
}

/** Called from live-pty-gate's exit choke point for every PTY; a no-op for unpinned ones. */
export function markPinnedClaudePtyExited(ptyId: string): void {
  const accountId = accountIdByPtyId.get(ptyId)
  seededUnconfirmedPtyIds.delete(ptyId)
  if (accountId === undefined) {
    return
  }
  accountIdByPtyId.delete(ptyId)
  persist()
  notifyIfDrained(accountId)
}

export function seedPinnedClaudePtysFromPersistence(entries: Record<string, string>): void {
  for (const [ptyId, accountId] of Object.entries(entries)) {
    accountIdByPtyId.set(ptyId, accountId)
    seededUnconfirmedPtyIds.add(ptyId)
  }
}

export function hasSeededUnconfirmedPinnedClaudePtys(): boolean {
  return seededUnconfirmedPtyIds.size > 0
}

/** Releases seeded ids the daemon no longer knows; live ones keep guarding their account. */
export function confirmSeededPinnedClaudePtys(aliveSessionIds: readonly string[]): void {
  const alive = new Set(aliveSessionIds)
  const drainedCandidates = new Set<string>()
  for (const ptyId of seededUnconfirmedPtyIds) {
    const accountId = accountIdByPtyId.get(ptyId)
    if (!alive.has(ptyId) && accountId !== undefined) {
      accountIdByPtyId.delete(ptyId)
      drainedCandidates.add(accountId)
    }
  }
  seededUnconfirmedPtyIds.clear()
  if (drainedCandidates.size > 0) {
    persist()
  }
  for (const accountId of drainedCandidates) {
    notifyIfDrained(accountId)
  }
}

function notifyIfDrained(accountId: string): void {
  if (countClaudePinnedAccountUsers(accountId) > 0) {
    return
  }
  for (const listener of drainListeners) {
    listener(accountId)
  }
}

function persist(): void {
  try {
    persistence?.write(Object.fromEntries(accountIdByPtyId))
  } catch (error) {
    // Why: the record only protects a restart; losing it must never fail a spawn or an exit.
    console.warn('[claude-pinned-pty] Failed to persist pinned Claude PTYs:', error)
  }
}

export function readClaudePinnedPtyRegistryFile(filePath: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return {}
  }
  const panes = parsed && typeof parsed === 'object' && 'panes' in parsed ? parsed.panes : undefined
  if (!panes || typeof panes !== 'object' || Array.isArray(panes)) {
    return {}
  }
  const entries: Record<string, string> = {}
  for (const [ptyId, accountId] of Object.entries(panes)) {
    if (typeof accountId === 'string' && accountId) {
      entries[ptyId] = accountId
    }
  }
  return entries
}

export function createClaudePinnedPtyFilePersistence(filePath: string): ClaudePinnedPtyPersistence {
  return {
    write(entries) {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileAtomically(filePath, `${JSON.stringify({ version: 1, panes: entries })}\n`, {
        mode: 0o600
      })
    }
  }
}

export const _internals = {
  reset(): void {
    accountIdByPtyId.clear()
    seededUnconfirmedPtyIds.clear()
    reservationsByAccountId.clear()
    drainListeners.clear()
    persistence = null
  }
}
