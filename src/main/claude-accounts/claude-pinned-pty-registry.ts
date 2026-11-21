import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writePluginFileAtomically } from '../plugins/installation/plugin-atomic-file-write'

/**
 * Which `--account` Claude PTYs run on which managed account, for the tab and status labels.
 * Persisted so a pane that survives a restart keeps naming its account before it reattaches.
 */
const accountIdByPtyId = new Map<string, string>()
// Why: restored at startup but not yet confirmed against the daemon, which drops the dead ones.
const seededUnconfirmedPtyIds = new Set<string>()

export type ClaudePinnedPtyPersistence = {
  write(entries: Record<string, string>): void | Promise<void>
}

let persistence: ClaudePinnedPtyPersistence | null = null

export function attachClaudePinnedPtyPersistence(target: ClaudePinnedPtyPersistence | null): void {
  persistence = target
}

export function getPinnedClaudeAccountIdForPty(ptyId: string): string | undefined {
  return accountIdByPtyId.get(ptyId)
}

export function markPinnedClaudePtySpawned(ptyId: string, accountId: string): void {
  accountIdByPtyId.set(ptyId, accountId)
  seededUnconfirmedPtyIds.delete(ptyId)
  persist()
}

/** A no-op for unpinned PTYs, so every exit can call it. */
export function markPinnedClaudePtyExited(ptyId: string): void {
  seededUnconfirmedPtyIds.delete(ptyId)
  if (accountIdByPtyId.delete(ptyId)) {
    persist()
  }
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

/** Drops seeded ids the daemon no longer knows. */
export function confirmSeededPinnedClaudePtys(aliveSessionIds: readonly string[]): void {
  const alive = new Set(aliveSessionIds)
  let dropped = false
  for (const ptyId of seededUnconfirmedPtyIds) {
    if (!alive.has(ptyId) && accountIdByPtyId.delete(ptyId)) {
      dropped = true
    }
  }
  seededUnconfirmedPtyIds.clear()
  if (dropped) {
    persist()
  }
}

function persist(): void {
  try {
    void Promise.resolve(persistence?.write(Object.fromEntries(accountIdByPtyId))).catch(
      warnPersistFailure
    )
  } catch (error) {
    warnPersistFailure(error)
  }
}

// Why: the record only keeps labels across a restart; losing it must never fail a spawn or an exit.
function warnPersistFailure(error: unknown): void {
  console.warn('[claude-pinned-pty] Failed to persist pinned Claude PTYs:', error)
}

export async function readClaudePinnedPtyRegistryFile(
  filePath: string
): Promise<Record<string, string>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf-8'))
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
  // Why chained: a later write must never land before an earlier one.
  let pending: Promise<void> = Promise.resolve()
  return {
    write(entries) {
      const contents = `${JSON.stringify({ version: 1, panes: entries })}\n`
      pending = pending
        .catch(() => undefined)
        .then(async () => {
          await mkdir(dirname(filePath), { recursive: true })
          await writePluginFileAtomically(filePath, contents, { mode: 0o600 })
        })
      return pending
    }
  }
}

export const _internals = {
  reset(): void {
    accountIdByPtyId.clear()
    seededUnconfirmedPtyIds.clear()
    persistence = null
  }
}
