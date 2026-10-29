import type { LegacyPaneKeyAliasEntry, PersistedState } from '../../../shared/persisted-state-types'

import type { MigrationUnsupportedPtyEntry } from '../../../shared/agent-status-types'

import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type { PaneAliasNormalizationOptions } from './pane-identity-migration'

import { sessionBindingIndex } from '../loading-store/session-binding-index'

import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

import { isTerminalLeafId, parsePaneKey } from '../../../shared/stable-pane-id'
import { findCrossHostPaneTabIds, withoutPaneTabIds } from './cross-host-pane-tab-ids'

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
import { normalizeWorkspaceSessionPaneIdentities } from './workspace-pane-normalization'
export type WorkspaceSessionPaneIdentityRemap = {
  leafIdByInputLeafIdByTabId: Map<string, Map<string, string>>
  leafIdByPtyIdByTabId: Map<string, Map<string, string>>
}

export function remapSshRemotePtyLeaseLeafIds(
  leases: SshRemotePtyLease[],
  remapsByHostId: ReadonlyMap<ExecutionHostId, WorkspaceSessionPaneIdentityRemap>,
  hostIdsWithWorkspaceSessions: ReadonlySet<ExecutionHostId> = new Set(remapsByHostId.keys()),
  selectedTabIds?: ReadonlySet<string>
): { leases: SshRemotePtyLease[]; changed: boolean } {
  let changed = false
  const remapLease = (lease: SshRemotePtyLease): SshRemotePtyLease => {
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
  }
  let nextLeases = leases
  if (selectedTabIds) {
    const index = sessionBindingIndex(leases)
    for (const tabId of selectedTabIds) {
      for (const position of index.positionsByTab.get(tabId) ?? []) {
        const next = remapLease(leases[position])
        if (next !== leases[position]) {
          if (nextLeases === leases) {
            nextLeases = [...leases]
          }
          nextLeases[position] = next
        }
      }
    }
  } else {
    nextLeases = leases.map(remapLease)
  }
  return { leases: nextLeases, changed }
}

export function mergeAcknowledgementLeafIdMapsByTabId(
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
