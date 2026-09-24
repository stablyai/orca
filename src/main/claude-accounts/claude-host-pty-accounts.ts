import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

/**
 * Which managed account each ordinary (unpinned) host Claude started on.
 *
 * Such a Claude keeps that account's token in memory and refreshes it through ~/.claude even
 * after the host switches to another account. Pinning the old account with `--account` while it
 * runs would give one single-use refresh chain two owners, so pinned reservations consult this.
 * `null` means the system default (no managed account), which a pinned launch never shares.
 */
const hostAccountIdByPtyId = new Map<string, string | null>()
// Why: structured children die with this process, so persisting them would only leave stale ids.
const unpersistedPtyIds = new Set<string>()
let resolveActiveHostAccountId: () => string | null = () => null

export type ClaudeHostPtyAccountPersistence = {
  write(entries: Record<string, string | null>): void
}

let persistence: ClaudeHostPtyAccountPersistence | null = null

export function attachClaudeHostPtyAccountPersistence(
  target: ClaudeHostPtyAccountPersistence | null
): void {
  persistence = target
}

/** The host's selected account; used when a launch did not report which account it prepared. */
export function setClaudeActiveHostAccountResolver(resolver: () => string | null): void {
  resolveActiveHostAccountId = resolver
}

/** `managed:<id>` is a host-managed launch; `system`, WSL, and suffixed provenances are not. */
export function hostClaudeAccountIdFromProvenance(provenance: string): string | null {
  const match = /^managed:([^:]+)$/.exec(provenance)
  return match ? match[1] : null
}

export function recordHostClaudePtyAccount(
  ptyId: string,
  accountId: string | null | undefined,
  options: { persist: boolean }
): void {
  hostAccountIdByPtyId.set(
    ptyId,
    accountId === undefined ? resolveActiveHostAccountId() : accountId
  )
  if (options.persist) {
    unpersistedPtyIds.delete(ptyId)
    persist()
  } else {
    unpersistedPtyIds.add(ptyId)
  }
}

export function forgetHostClaudePtyAccount(ptyId: string): void {
  const wasPersisted = !unpersistedPtyIds.delete(ptyId)
  if (hostAccountIdByPtyId.delete(ptyId) && wasPersisted) {
    persist()
  }
}

export function countHostClaudePtysForAccount(accountId: string): number {
  let count = 0
  for (const hostAccountId of hostAccountIdByPtyId.values()) {
    if (hostAccountId === accountId) {
      count += 1
    }
  }
  return count
}

/**
 * Restores attribution for Claude PTYs the daemon kept alive across a restart. A PTY with no
 * record (one that started before this record existed) is attributed to the account selected
 * now: the selection persists across restarts, so that is the account it most plausibly used.
 */
export function seedHostClaudePtyAccounts(
  sessionIds: readonly string[],
  recorded: Record<string, string | null>
): void {
  for (const sessionId of sessionIds) {
    hostAccountIdByPtyId.set(
      sessionId,
      Object.hasOwn(recorded, sessionId) ? recorded[sessionId] : resolveActiveHostAccountId()
    )
  }
  persist()
}

function persist(): void {
  const entries: Record<string, string | null> = {}
  for (const [ptyId, accountId] of hostAccountIdByPtyId) {
    if (!unpersistedPtyIds.has(ptyId)) {
      entries[ptyId] = accountId
    }
  }
  try {
    persistence?.write(entries)
  } catch (error) {
    // Why: the record only protects a restart; losing it must never fail a spawn or an exit.
    console.warn('[claude-host-pty] Failed to persist host Claude PTY accounts:', error)
  }
}

export function readClaudeHostPtyAccountsFile(filePath: string): Record<string, string | null> {
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
  const entries: Record<string, string | null> = {}
  for (const [ptyId, accountId] of Object.entries(panes)) {
    if (accountId === null || (typeof accountId === 'string' && accountId)) {
      entries[ptyId] = accountId
    }
  }
  return entries
}

export function createClaudeHostPtyAccountFilePersistence(
  filePath: string
): ClaudeHostPtyAccountPersistence {
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
    hostAccountIdByPtyId.clear()
    unpersistedPtyIds.clear()
    resolveActiveHostAccountId = () => null
    persistence = null
  }
}
