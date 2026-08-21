import type { LegacyPaneKeyAliasEntry, PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { MigrationUnsupportedPtyEntry } from '../../../shared/agent-status-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { findCrossHostPaneTabIds, withoutPaneTabIds } from './cross-host-pane-tab-ids'
import { registerLegacyPaneKeyAliasesForTab } from './pane-identity-migration'
import { normalizeTerminalLayoutSnapshotForPersistence } from './terminal-layout-normalization'
import {
  legacyMigrationUnsupportedRowsToAliasEntries,
  legacyPaneKeyAliasEntriesEqual,
  mergeLegacyPaneKeyAliasEntries,
  migrationUnsupportedEntriesEqual,
  normalizeLegacyPaneKeyAliasEntries
} from './pane-alias-normalization'

export function normalizeWorkspaceSessionPaneIdentities(
  session: WorkspaceSessionState,
  priorLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {},
  options: { skipAliasTabIds?: ReadonlySet<string> } = {}
): {
  session: WorkspaceSessionState
  changed: boolean
  leafIdByInputLeafIdByTabId: Map<string, Map<string, string>>
  leafIdByPtyIdByTabId: Map<string, Map<string, string>>
  migrationUnsupportedEntries: MigrationUnsupportedPtyEntry[]
  legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[]
} {
  let changed = false
  const leafIdByInputLeafIdByTabId = new Map<string, Map<string, string>>()
  const leafIdByPtyIdByTabId = new Map<string, Map<string, string>>()
  // Why always empty: legacy numeric pane keys are bridged by aliases now, not persisted as
  // restart-required rows; the field stays so callers keep clearing stale rows written by old builds.
  const migrationUnsupportedEntries: MigrationUnsupportedPtyEntry[] = []
  const legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[] = []
  const terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const normalized = normalizeTerminalLayoutSnapshotForPersistence(
      layout,
      priorLayoutsByTabId[tabId]
    )
    terminalLayoutsByTabId[tabId] = normalized.snapshot
    leafIdByInputLeafIdByTabId.set(tabId, normalized.leafIdByInputLeafId)
    if (!options.skipAliasTabIds?.has(tabId)) {
      const tabAliasEntries = registerLegacyPaneKeyAliasesForTab({
        session,
        tabId,
        inputLayout: layout,
        normalizedLayout: normalized.snapshot,
        leafIdByInputLeafId: normalized.leafIdByInputLeafId
      })
      // Why: old split layouts can generate enough alias rows to exceed V8's argument limit if spread into push().
      for (const entry of tabAliasEntries) {
        legacyPaneKeyAliasEntries.push(entry)
      }
    }
    const leafIdByPtyId = new Map<string, string>()
    const duplicatePtyIds = new Set<string>()
    for (const [leafId, ptyId] of Object.entries(normalized.snapshot.ptyIdsByLeafId ?? {})) {
      if (duplicatePtyIds.has(ptyId)) {
        continue
      }
      if (leafIdByPtyId.has(ptyId)) {
        leafIdByPtyId.delete(ptyId)
        duplicatePtyIds.add(ptyId)
        continue
      }
      leafIdByPtyId.set(ptyId, leafId)
    }
    leafIdByPtyIdByTabId.set(tabId, leafIdByPtyId)
    changed ||= normalized.changed
  }
  return {
    session: changed ? { ...session, terminalLayoutsByTabId } : session,
    changed,
    leafIdByInputLeafIdByTabId,
    leafIdByPtyIdByTabId,
    migrationUnsupportedEntries,
    legacyPaneKeyAliasEntries
  }
}

export type WorkspaceSessionPaneIdentityRemap = {
  leafIdByInputLeafIdByTabId: Map<string, Map<string, string>>
  leafIdByPtyIdByTabId: Map<string, Map<string, string>>
}

export function remapSshRemotePtyLeaseLeafIds(
  leases: SshRemotePtyLease[],
  remapsByHostId: ReadonlyMap<ExecutionHostId, WorkspaceSessionPaneIdentityRemap>,
  hostIdsWithWorkspaceSessions: ReadonlySet<ExecutionHostId> = new Set(remapsByHostId.keys())
): { leases: SshRemotePtyLease[]; changed: boolean } {
  let changed = false
  const nextLeases = leases.map((lease) => {
    if (lease.leafId === undefined) {
      return lease
    }
    const hostId = toSshExecutionHostId(lease.targetId)
    // Legacy unpartitioned state kept SSH panes in local; only fall back when this host has no partition.
    const remap =
      remapsByHostId.get(hostId) ??
      (hostIdsWithWorkspaceSessions.has(hostId)
        ? undefined
        : remapsByHostId.get(LOCAL_EXECUTION_HOST_ID))
    const remappedLeafId = lease.tabId
      ? remap?.leafIdByInputLeafIdByTabId.get(lease.tabId)?.get(lease.leafId)
      : undefined
    const leafIdForPty = lease.tabId
      ? remap?.leafIdByPtyIdByTabId.get(lease.tabId)?.get(lease.ptyId)
      : undefined
    const nextLeafId = remappedLeafId ?? leafIdForPty
    if (nextLeafId) {
      if (nextLeafId === lease.leafId) {
        return lease
      }
      changed = true
      return { ...lease, leafId: nextLeafId }
    }
    if (isTerminalLeafId(lease.leafId)) {
      return lease
    }
    changed = true
    const next = { ...lease }
    // Why: unmatched legacy leaf ids are ambiguous after migration; don't re-persist them as durable pane identity.
    delete next.leafId
    return next
  })
  return { leases: nextLeases, changed }
}

/** Acknowledgement keys lack host metadata, so an already-mapped tab keeps its mapping. */
function mergeAcknowledgementLeafIdMapsByTabId(
  target: Map<string, Map<string, string>>,
  source: Map<string, Map<string, string>>
): Map<string, Map<string, string>> {
  const merged = new Map(target)
  for (const [tabId, leafIds] of source) {
    const existing = merged.get(tabId)
    merged.set(tabId, existing ? new Map([...leafIds, ...existing]) : new Map(leafIds))
  }
  return merged
}

export function normalizePersistedPaneIdentityState(state: PersistedState): {
  state: PersistedState
  changed: boolean
  migrationUnsupportedEntries: MigrationUnsupportedPtyEntry[]
  legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[]
} {
  const crossHostTabIds = findCrossHostPaneTabIds(state)
  const normalizedSession = normalizeWorkspaceSessionPaneIdentities(
    state.workspaceSession,
    {},
    {
      skipAliasTabIds: crossHostTabIds
    }
  )
  let acknowledgementLeafIdByInputLeafIdByTabId = normalizedSession.leafIdByInputLeafIdByTabId
  const remapsByHostId = new Map<ExecutionHostId, WorkspaceSessionPaneIdentityRemap>([
    [LOCAL_EXECUTION_HOST_ID, normalizedSession]
  ])
  const hostSessionLegacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[] = []
  // Why: SSH/runtime hosts keep their own session blob, and their legacy leaves need the same UUID
  // rewrite — otherwise their leases and read markers still point at `pane:1` after migration.
  const normalizedHostSessions = state.workspaceSessionsByHostId
    ? { ...state.workspaceSessionsByHostId }
    : undefined
  let hostSessionsChanged = false
  if (normalizedHostSessions) {
    for (const hostId of Object.keys(
      normalizedHostSessions
    ) as (keyof typeof normalizedHostSessions)[]) {
      const hostSession = normalizedHostSessions[hostId]
      if (!hostSession) {
        continue
      }
      const normalizedHostSession = normalizeWorkspaceSessionPaneIdentities(
        hostSession,
        {},
        {
          skipAliasTabIds: crossHostTabIds
        }
      )
      normalizedHostSessions[hostId] = normalizedHostSession.session
      remapsByHostId.set(hostId, normalizedHostSession)
      acknowledgementLeafIdByInputLeafIdByTabId = mergeAcknowledgementLeafIdMapsByTabId(
        acknowledgementLeafIdByInputLeafIdByTabId,
        normalizedHostSession.leafIdByInputLeafIdByTabId
      )
      for (const entry of normalizedHostSession.legacyPaneKeyAliasEntries) {
        hostSessionLegacyPaneKeyAliasEntries.push(entry)
      }
      hostSessionsChanged ||= normalizedHostSession.changed
    }
  }
  const remappedLeases = remapSshRemotePtyLeaseLeafIds(
    state.sshRemotePtyLeases ?? [],
    remapsByHostId
  )
  const mergedMigrationUnsupportedEntries: MigrationUnsupportedPtyEntry[] = []
  const mergedLegacyPaneKeyAliasEntries = mergeLegacyPaneKeyAliasEntries([
    ...normalizeLegacyPaneKeyAliasEntries(state.legacyPaneKeyAliasEntries),
    ...legacyMigrationUnsupportedRowsToAliasEntries(state.migrationUnsupportedPtyEntries ?? []),
    ...normalizedSession.legacyPaneKeyAliasEntries,
    ...hostSessionLegacyPaneKeyAliasEntries
    // Rows an older build wrote for a now-colliding tab id would keep the ambiguous routing alive.
  ]).filter((entry) => !crossHostTabIds.has(parsePaneKey(entry.stablePaneKey)?.tabId ?? ''))
  const remappedAcknowledgements = remapAcknowledgedAgentPaneKeys(
    state.ui?.acknowledgedAgentsByPaneKey,
    withoutPaneTabIds(acknowledgementLeafIdByInputLeafIdByTabId, crossHostTabIds)
  )
  const migrationUnsupportedChanged = !migrationUnsupportedEntriesEqual(
    state.migrationUnsupportedPtyEntries ?? [],
    mergedMigrationUnsupportedEntries
  )
  const legacyAliasesChanged = !legacyPaneKeyAliasEntriesEqual(
    state.legacyPaneKeyAliasEntries ?? [],
    mergedLegacyPaneKeyAliasEntries
  )
  if (
    !normalizedSession.changed &&
    !hostSessionsChanged &&
    !remappedLeases.changed &&
    !migrationUnsupportedChanged &&
    !legacyAliasesChanged &&
    !remappedAcknowledgements.changed
  ) {
    return {
      state,
      changed: false,
      migrationUnsupportedEntries: mergedMigrationUnsupportedEntries,
      legacyPaneKeyAliasEntries: mergedLegacyPaneKeyAliasEntries
    }
  }
  return {
    state: {
      ...state,
      workspaceSession: normalizedSession.session,
      ...(normalizedHostSessions ? { workspaceSessionsByHostId: normalizedHostSessions } : {}),
      sshRemotePtyLeases: remappedLeases.leases,
      migrationUnsupportedPtyEntries: mergedMigrationUnsupportedEntries,
      legacyPaneKeyAliasEntries: mergedLegacyPaneKeyAliasEntries,
      ...(remappedAcknowledgements.changed
        ? {
            ui: {
              ...state.ui,
              acknowledgedAgentsByPaneKey: remappedAcknowledgements.acknowledgements
            }
          }
        : {})
    },
    changed: true,
    migrationUnsupportedEntries: mergedMigrationUnsupportedEntries,
    legacyPaneKeyAliasEntries: mergedLegacyPaneKeyAliasEntries
  }
}

export function remapAcknowledgedAgentPaneKeys(
  acknowledgements: PersistedState['ui']['acknowledgedAgentsByPaneKey'],
  leafIdByInputLeafIdByTabId: Map<string, Map<string, string>>
): { acknowledgements: PersistedState['ui']['acknowledgedAgentsByPaneKey']; changed: boolean } {
  if (!acknowledgements || Object.keys(acknowledgements).length === 0) {
    return { acknowledgements, changed: false }
  }

  let changed = false
  const next: NonNullable<PersistedState['ui']['acknowledgedAgentsByPaneKey']> = {}
  const setAcknowledgement = (paneKey: string, acknowledgedAt: number): void => {
    const existing = next[paneKey]
    next[paneKey] = existing === undefined ? acknowledgedAt : Math.max(existing, acknowledgedAt)
  }
  for (const [paneKey, acknowledgedAt] of Object.entries(acknowledgements)) {
    const parsed = parsePaneKey(paneKey)
    if (parsed) {
      setAcknowledgement(paneKey, acknowledgedAt)
      continue
    }

    const delimiter = paneKey.indexOf(':')
    if (delimiter <= 0 || delimiter === paneKey.length - 1) {
      setAcknowledgement(paneKey, acknowledgedAt)
      continue
    }

    const tabId = paneKey.slice(0, delimiter)
    const legacyLeafId = paneKey.slice(delimiter + 1)
    const remappedLeafId = leafIdByInputLeafIdByTabId.get(tabId)?.get(legacyLeafId)
    if (!remappedLeafId || !isTerminalLeafId(remappedLeafId)) {
      setAcknowledgement(paneKey, acknowledgedAt)
      continue
    }

    try {
      // Why: when a legacy leaf is promoted to a UUID, carry the read marker over so seen rows don't come back unread.
      setAcknowledgement(makePaneKey(tabId, remappedLeafId), acknowledgedAt)
      changed = true
    } catch {
      setAcknowledgement(paneKey, acknowledgedAt)
    }
  }

  return { acknowledgements: next, changed }
}
