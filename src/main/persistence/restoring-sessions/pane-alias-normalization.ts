import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import type { MigrationUnsupportedPtyEntry } from '../../../shared/agent-status-types'
import { canRegisterPaneKeyAlias, isOpaqueRemintedPaneKey } from '../../../shared/pane-key-alias'
import {
  isTerminalLeafId,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../shared/stable-pane-id'
import { agentHookServer } from '../../agent-hooks/server'

export function legacyMigrationUnsupportedRowsToAliasEntries(
  entries: MigrationUnsupportedPtyEntry[]
): LegacyPaneKeyAliasEntry[] {
  const normalizedEntries = normalizeMigrationUnsupportedPtyEntries(entries).filter(
    (entry) => entry.tabId && entry.paneKey && parsePaneKey(entry.paneKey)
  )
  const entriesByTabId = new Map<string, MigrationUnsupportedPtyEntry | null>()
  for (const entry of normalizedEntries) {
    const tabId = entry.tabId
    if (!tabId) {
      continue
    }
    entriesByTabId.set(tabId, entriesByTabId.has(tabId) ? null : entry)
  }
  const aliasEntries: LegacyPaneKeyAliasEntry[] = []
  for (const [tabId, entry] of entriesByTabId) {
    if (!entry?.paneKey) {
      continue
    }
    // Pre-stable rows lack numeric keys; synthesize aliases only for unambiguous single panes.
    for (const legacyPaneKey of [`${tabId}:0`, `${tabId}:1`]) {
      aliasEntries.push({
        ptyId: entry.ptyId,
        legacyPaneKey,
        stablePaneKey: entry.paneKey,
        updatedAt: entry.updatedAt
      })
    }
  }
  return aliasEntries
}

// Bound history so SSH-target remove/re-add churn cannot grow state forever.
export const MAX_REMOVED_SSH_TARGET_TOMBSTONES = 50

export function normalizeMigrationUnsupportedPtyEntries(
  value: unknown
): MigrationUnsupportedPtyEntry[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((entry): entry is MigrationUnsupportedPtyEntry => {
    if (!entry || typeof entry !== 'object') {
      return false
    }
    const candidate = entry as Partial<MigrationUnsupportedPtyEntry>
    return (
      typeof candidate.ptyId === 'string' &&
      candidate.ptyId.length > 0 &&
      (candidate.worktreeId === undefined || typeof candidate.worktreeId === 'string') &&
      (candidate.tabId === undefined || typeof candidate.tabId === 'string') &&
      (candidate.leafId === undefined || isTerminalLeafId(candidate.leafId)) &&
      (candidate.paneKey === undefined || typeof candidate.paneKey === 'string') &&
      candidate.reason === 'legacy-numeric-pane-key' &&
      (candidate.source === 'local' || candidate.source === 'ssh') &&
      Number.isFinite(candidate.updatedAt)
    )
  })
}

export function normalizeLegacyPaneKeyAliasEntries(value: unknown): LegacyPaneKeyAliasEntry[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((entry): entry is LegacyPaneKeyAliasEntry => {
    if (!entry || typeof entry !== 'object') {
      return false
    }
    const candidate = entry as Partial<LegacyPaneKeyAliasEntry>
    if (
      typeof candidate.ptyId !== 'string' ||
      candidate.ptyId.trim().length === 0 ||
      typeof candidate.legacyPaneKey !== 'string' ||
      typeof candidate.stablePaneKey !== 'string' ||
      !Number.isFinite(candidate.updatedAt)
    ) {
      return false
    }
    return (
      canRegisterPaneKeyAlias(candidate.legacyPaneKey, candidate.stablePaneKey) ||
      Boolean(parsePaneKey(candidate.legacyPaneKey) && parsePaneKey(candidate.stablePaneKey))
    )
  })
}

export function registerPersistedPaneKeyAlias(entry: LegacyPaneKeyAliasEntry): void {
  if (
    parseLegacyNumericPaneKey(entry.legacyPaneKey) ||
    isOpaqueRemintedPaneKey(entry.legacyPaneKey)
  ) {
    agentHookServer.registerPaneKeyAlias(
      entry.legacyPaneKey,
      entry.stablePaneKey,
      entry.ptyId,
      entry.updatedAt,
      { overwriteExisting: false }
    )
    return
  }
  // Restore detached agents' physical-to-owner routing before replaying hook events.
  agentHookServer.transferPaneAuthority(
    entry.legacyPaneKey,
    entry.stablePaneKey,
    entry.ptyId,
    entry.updatedAt,
    { authorityVerified: false }
  )
}

export function mergeLegacyPaneKeyAliasEntries(
  entries: LegacyPaneKeyAliasEntry[]
): LegacyPaneKeyAliasEntry[] {
  const byLegacyPaneKey = new Map<string, LegacyPaneKeyAliasEntry>()
  for (const entry of normalizeLegacyPaneKeyAliasEntries(entries)) {
    const existing = byLegacyPaneKey.get(entry.legacyPaneKey)
    if (!existing || existing.updatedAt <= entry.updatedAt) {
      byLegacyPaneKey.set(entry.legacyPaneKey, entry)
    }
  }
  return [...byLegacyPaneKey.values()]
}

export function legacyPaneKeyAliasEntriesEqual(
  left: LegacyPaneKeyAliasEntry[],
  right: LegacyPaneKeyAliasEntry[]
): boolean {
  if (left.length !== right.length) {
    return false
  }
  const rightByLegacyPaneKey = new Map(right.map((entry) => [entry.legacyPaneKey, entry]))
  // Ignore JSON key ordering to avoid false dirty-state detection.
  return left.every((entry) => {
    const other = rightByLegacyPaneKey.get(entry.legacyPaneKey)
    return (
      other !== undefined &&
      entry.ptyId === other.ptyId &&
      entry.stablePaneKey === other.stablePaneKey &&
      entry.updatedAt === other.updatedAt
    )
  })
}

export function migrationUnsupportedEntriesEqual(
  left: MigrationUnsupportedPtyEntry[],
  right: MigrationUnsupportedPtyEntry[]
): boolean {
  if (left.length !== right.length) {
    return false
  }
  const rightByPtyId = new Map(right.map((entry) => [entry.ptyId, entry]))
  return left.every((entry) => {
    const other = rightByPtyId.get(entry.ptyId)
    return (
      other !== undefined &&
      entry.worktreeId === other.worktreeId &&
      entry.tabId === other.tabId &&
      entry.leafId === other.leafId &&
      entry.paneKey === other.paneKey &&
      entry.reason === other.reason &&
      entry.source === other.source &&
      entry.updatedAt === other.updatedAt
    )
  })
}
