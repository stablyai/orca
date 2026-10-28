import type { LegacyPaneKeyAliasEntry, PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { MigrationUnsupportedPtyEntry } from '../../../shared/agent-status-types'
import { agentHookServer } from '../../agent-hooks/server'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { isTerminalLeafId, parsePaneKey } from '../../../shared/stable-pane-id'
import { findCrossHostPaneTabIds, withoutPaneTabIds } from './cross-host-pane-tab-ids'
import {
  createLazyTerminalTabLookup,
  collectLegacyPaneKeyAliasesForTab,
  type PaneAliasNormalizationOptions
} from './pane-identity-migration'
import { normalizeTerminalLayoutSnapshotForPersistence } from './terminal-layout-normalization'
import {
  legacyMigrationUnsupportedRowsToAliasEntries,
  legacyPaneKeyAliasEntriesEqual,
  mergeLegacyPaneKeyAliasEntries,
  migrationUnsupportedEntriesEqual,
  normalizeLegacyPaneKeyAliasEntries
} from './pane-alias-normalization'
import {
  remapAcknowledgedAgentPaneKeys,
  remapActivityClearedAtPaneKeys,
  remapManuallyUnreadTurnPaneKeys
} from './pane-key-remapping'

export {
  remapAcknowledgedAgentPaneKeys,
  remapActivityClearedAtPaneKeys,
  remapManuallyUnreadTurnPaneKeys
} from './pane-key-remapping'

export function normalizeWorkspaceSessionPaneIdentities(
  session: WorkspaceSessionState,
  priorLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {},
  options: PaneAliasNormalizationOptions & { skipAliasTabIds?: ReadonlySet<string> } = {}
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
  const legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[] = []
  const terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
  let tabsById: ReturnType<typeof createLazyTerminalTabLookup> | null = null
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const normalized = normalizeTerminalLayoutSnapshotForPersistence(
      layout,
      priorLayoutsByTabId[tabId]
    )
    terminalLayoutsByTabId[tabId] = normalized.snapshot
    leafIdByInputLeafIdByTabId.set(tabId, normalized.leafIdByInputLeafId)
    if (!options.skipAliasTabIds?.has(tabId)) {
      tabsById ??= createLazyTerminalTabLookup(session)
      const tabAliasEntries = collectLegacyPaneKeyAliasesForTab({
        tabId,
        tab: tabsById.get(tabId),
        inputLayout: layout,
        normalizedLayout: normalized.snapshot,
        leafIdByInputLeafId: normalized.leafIdByInputLeafId
      })
      // Split layouts can exceed V8's argument limit if aliases are spread into push.
      for (const entry of tabAliasEntries) {
        if (options.registerAliases !== false) {
          agentHookServer.registerPaneKeyAlias(
            entry.legacyPaneKey,
            entry.stablePaneKey,
            entry.ptyId
          )
        }
        if (entry.ptyId) {
          legacyPaneKeyAliasEntries.push({ ...entry, ptyId: entry.ptyId })
        } else {
          options.collectUnboundPaneAlias?.(entry)
        }
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
    // Alias replacement still requires callers to clear the legacy restart-required field.
    migrationUnsupportedEntries: [],
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
    // Legacy SSH panes spill into local only when their host partition is absent.
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
    // Unmatched legacy leaf IDs cannot safely become durable pane identities.
    delete next.leafId
    return next
  })
  return { leases: nextLeases, changed }
}

/** Hostless acknowledgement keys must keep their first tab mapping. */
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

export function normalizePersistedPaneIdentityState(
  state: PersistedState,
  options: PaneAliasNormalizationOptions = {}
): {
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
      ...options,
      skipAliasTabIds: crossHostTabIds
    }
  )
  let acknowledgementLeafIdByInputLeafIdByTabId = normalizedSession.leafIdByInputLeafIdByTabId
  const remapsByHostId = new Map<ExecutionHostId, WorkspaceSessionPaneIdentityRemap>([
    [LOCAL_EXECUTION_HOST_ID, normalizedSession]
  ])
  const hostSessionLegacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[] = []
  // Remote partitions need UUID migration too or leases/read markers keep legacy pane IDs.
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
          ...options,
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
    // Filter old aliases too so preexisting cross-host tab collisions cannot preserve ambiguous routes.
  ]).filter((entry) => !crossHostTabIds.has(parsePaneKey(entry.stablePaneKey)?.tabId ?? ''))
  const remappedAcknowledgements = remapAcknowledgedAgentPaneKeys(
    state.ui?.acknowledgedAgentsByPaneKey,
    withoutPaneTabIds(acknowledgementLeafIdByInputLeafIdByTabId, crossHostTabIds)
  )
  const remappedActivityCutoffs = remapActivityClearedAtPaneKeys(
    state.ui?.activityClearedAtByPaneKey,
    withoutPaneTabIds(acknowledgementLeafIdByInputLeafIdByTabId, crossHostTabIds)
  )
  const remappedManualUnread = remapManuallyUnreadTurnPaneKeys(
    state.ui?.manuallyUnreadTurnsByPaneKey,
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
    !remappedAcknowledgements.changed &&
    !remappedActivityCutoffs.changed &&
    !remappedManualUnread.changed
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
      ...(remappedAcknowledgements.changed ||
      remappedActivityCutoffs.changed ||
      remappedManualUnread.changed
        ? {
            ui: {
              ...state.ui,
              ...(remappedAcknowledgements.changed
                ? { acknowledgedAgentsByPaneKey: remappedAcknowledgements.acknowledgements }
                : {}),
              ...(remappedActivityCutoffs.changed
                ? { activityClearedAtByPaneKey: remappedActivityCutoffs.cutoffs }
                : {}),
              ...(remappedManualUnread.changed
                ? { manuallyUnreadTurnsByPaneKey: remappedManualUnread.turns }
                : {})
            }
          }
        : {})
    },
    changed: true,
    migrationUnsupportedEntries: mergedMigrationUnsupportedEntries,
    legacyPaneKeyAliasEntries: mergedLegacyPaneKeyAliasEntries
  }
}
