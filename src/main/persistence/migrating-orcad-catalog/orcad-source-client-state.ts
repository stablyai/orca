import { hostStableKey } from '../../../shared/automation-owner-key'
import { parsePersistedAutomationHostFilter } from '../../../shared/automation-host-filter'
import type {
  OrcadMigrationClientStatePayload,
  OrcadMigrationUiRoutingState
} from '../../../shared/orcad-migration-client-state'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration-manifest'
import type {
  PersistedMobileClientTabSelection,
  PersistedState
} from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { orcadMigrationPaneBelongsToTabs } from './orcad-source-session-dependencies'
import { collectCloseIntents } from './orcad-source-client-browser-intents'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  unqualifyOrcadMigrationOwnerKey
} from './orcad-source-scope'

export type OrcadMigrationSourceClientStateInspection = {
  payload: OrcadMigrationClientStatePayload | undefined
  /** Invalid or unmatched closes are folded into the existing workspace-session blocker. */
  blockedCount: number
  blockedCounts: {
    'mobile-tab-selection': number
    'ui-routing': number
    'saved-port-forward': number
  }
}

export function collectOrcadMigrationSourceClientState(
  state: PersistedState,
  source: OrcadMigrationManifestSource,
  catalog: OrcadMigrationCatalogPayload,
  destinationEnvironmentId: string | undefined,
  eligibleSession: WorkspaceSessionState | undefined
): OrcadMigrationSourceClientStateInspection {
  const scope = createOrcadMigrationSourceScope({ source, catalog })
  const blockedCounts = {
    'mobile-tab-selection': 0,
    'ui-routing': 0,
    'saved-port-forward': 0
  }
  let blockedCount = 0
  const mobile = collectMobileSelections(state, scope, eligibleSession, blockedCounts)
  const uiRouting = collectUiRouting(
    state,
    scope,
    destinationEnvironmentId,
    eligibleSession,
    blockedCounts
  )
  const target = state.sshTargets.find((entry) => entry.id === scope.targetId)
  const savedPortForwards = target?.portForwards ? structuredClone(target.portForwards) : undefined
  if (savedPortForwards) {
    const ports = new Set<number>()
    for (const forward of savedPortForwards) {
      if (ports.has(forward.localPort)) {
        blockedCounts['saved-port-forward'] += 1
      }
      ports.add(forward.localPort)
    }
  }
  const closeIntents = collectCloseIntents(
    state,
    scope,
    destinationEnvironmentId,
    eligibleSession,
    () => {
      blockedCount += 1
    }
  )
  const clientState: OrcadMigrationClientStatePayload = {
    ...(mobile && Object.keys(mobile).length > 0
      ? { mobileClientTabSelectionsByDeviceId: mobile }
      : {}),
    ...(uiRouting && Object.keys(uiRouting).length > 0 ? { uiRouting } : {}),
    ...(savedPortForwards && savedPortForwards.length > 0 ? { savedPortForwards } : {}),
    ...(closeIntents && closeIntents.length > 0
      ? { clientHostedBrowserCloseIntents: closeIntents }
      : {})
  }
  return {
    payload: Object.keys(clientState).length > 0 ? clientState : undefined,
    blockedCount,
    blockedCounts
  }
}

function collectMobileSelections(
  state: PersistedState,
  scope: ReturnType<typeof createOrcadMigrationSourceScope>,
  session: WorkspaceSessionState | undefined,
  blockedCounts: OrcadMigrationSourceClientStateInspection['blockedCounts']
):
  | NonNullable<OrcadMigrationClientStatePayload['mobileClientTabSelectionsByDeviceId']>
  | undefined {
  const eligible = session ? collectEligibleSessionIdentity(session, scope) : null
  const result: NonNullable<
    OrcadMigrationClientStatePayload['mobileClientTabSelectionsByDeviceId']
  > = {}
  const destinationKeys = new Set<string>()
  for (const [deviceId, selections] of Object.entries(
    state.mobileClientTabSelectionsByDeviceId ?? {}
  )) {
    const projected: Record<string, PersistedMobileClientTabSelection> = {}
    for (const [ownerKey, selection] of Object.entries(selections)) {
      if (!orcadMigrationOwnerMatchesScope(ownerKey, scope)) {
        continue
      }
      const destinationKey = unqualifyOrcadMigrationOwnerKey(ownerKey)
      if (destinationKeys.has(`${deviceId}\0${destinationKey}`)) {
        blockedCounts['mobile-tab-selection'] += 1
        continue
      }
      if (!mobileSelectionIsRepresentable(selection, eligible)) {
        blockedCounts['mobile-tab-selection'] += 1
        continue
      }
      destinationKeys.add(`${deviceId}\0${destinationKey}`)
      projected[destinationKey] = structuredClone(selection)
    }
    if (Object.keys(projected).length > 0) {
      result[deviceId] = projected
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function collectUiRouting(
  state: PersistedState,
  scope: ReturnType<typeof createOrcadMigrationSourceScope>,
  destinationEnvironmentId: string | undefined,
  session: WorkspaceSessionState | undefined,
  blockedCounts: OrcadMigrationSourceClientStateInspection['blockedCounts']
): OrcadMigrationUiRoutingState | undefined {
  const ui = state.ui
  const result: OrcadMigrationUiRoutingState = {}
  if (ui.lastActiveRepoId && scope.repoIds.has(ui.lastActiveRepoId)) {
    result.lastActiveRepoId = ui.lastActiveRepoId
  }
  if (ui.lastActiveWorktreeId && orcadMigrationOwnerMatchesScope(ui.lastActiveWorktreeId, scope)) {
    result.lastActiveWorktreeId = unqualifyOrcadMigrationOwnerKey(ui.lastActiveWorktreeId)
  }
  const filterRepoIds = ui.filterRepoIds.filter((repoId) => scope.repoIds.has(repoId))
  if (filterRepoIds.length > 0) {
    result.filterRepoIds = filterRepoIds
  }
  const dotfiles = Object.entries(ui.showDotfilesByWorktree ?? {})
    .filter(([ownerKey]) => orcadMigrationOwnerMatchesScope(ownerKey, scope))
    .map(([ownerKey, enabled]) => [unqualifyOrcadMigrationOwnerKey(ownerKey), enabled] as const)
  if (dotfiles.length > 0) {
    result.showDotfilesByWorktree = Object.fromEntries(dotfiles)
  }
  const dismissed = (ui.setupScriptPromptDismissedRepoIds ?? []).filter((repoId) =>
    scope.repoIds.has(repoId)
  )
  if (dismissed.length > 0) {
    result.setupScriptPromptDismissedRepoIds = dismissed
  }
  const manualOrder = (ui.manualRepoOrder ?? [])
    .filter((entry) => entry.hostId === scope.hostId && scope.repoIds.has(entry.repoId))
    .map((entry) => ({ hostId: 'local' as const, repoId: entry.repoId }))
  if (manualOrder.length > 0) {
    result.manualRepoOrder = manualOrder
  }
  if (ui.workspaceHostScope === scope.hostId) {
    result.workspaceHostScope = 'local'
  }
  const visibleHosts = (ui.visibleWorkspaceHostIds ?? []).filter(
    (hostId) => hostId === scope.hostId
  )
  if (visibleHosts.length > 0) {
    result.visibleWorkspaceHostIds = ['local']
  }
  const hostOrder = (ui.workspaceHostOrder ?? []).filter((hostId) => hostId === scope.hostId)
  if (hostOrder.length > 0) {
    result.workspaceHostOrder = ['local']
  }
  const filter = parsePersistedAutomationHostFilter(ui.automationHostFilter)
  if (
    filter.kind === 'host' &&
    hostStableKey(filter.host) === `host:desktop:ssh:${encodeURIComponent(scope.targetId)}`
  ) {
    result.automationHostFilter = destinationEnvironmentId
      ? {
          kind: 'host',
          hostKey: hostStableKey({
            authority: { kind: 'runtime', environmentId: destinationEnvironmentId },
            selector: { kind: 'self' }
          })
        }
      : { kind: 'host', hostKey: 'host:desktop:self' }
  }
  const eligible = session ? collectEligibleSessionIdentity(session, scope) : null
  const acknowledgements = Object.entries(ui.acknowledgedAgentsByPaneKey ?? {}).filter(
    ([paneKey]) => {
      const allowed = eligible ? orcadMigrationPaneBelongsToTabs(paneKey, eligible.tabIds) : false
      if (!allowed) {
        blockedCounts['ui-routing'] += 1
      }
      return allowed
    }
  )
  if (acknowledgements.length > 0) {
    result.acknowledgedAgentsByPaneKey = Object.fromEntries(acknowledgements)
  }
  return Object.keys(result).length > 0 ? result : undefined
}

type EligibleSessionIdentity = { tabIds: ReadonlySet<string>; groupIds: ReadonlySet<string> }

function collectEligibleSessionIdentity(
  session: WorkspaceSessionState,
  scope: ReturnType<typeof createOrcadMigrationSourceScope>
): EligibleSessionIdentity {
  const tabIds = new Set<string>()
  const groupIds = new Set<string>()
  for (const [ownerKey, tabs] of Object.entries(session.tabsByWorktree)) {
    if (!orcadMigrationOwnerMatchesScope(ownerKey, scope)) {
      continue
    }
    tabs.forEach((tab) => tabIds.add(tab.id))
  }
  for (const [ownerKey, groups] of Object.entries(session.tabGroups ?? {})) {
    if (!orcadMigrationOwnerMatchesScope(ownerKey, scope)) {
      continue
    }
    groups.forEach((group) => groupIds.add(group.id))
  }
  return { tabIds, groupIds }
}

function mobileSelectionIsRepresentable(
  selection: PersistedMobileClientTabSelection,
  eligible: EligibleSessionIdentity | null
): boolean {
  if (!eligible) {
    return (
      selection.activeTabId === null &&
      selection.activeGroupId === null &&
      Object.keys(selection.activeTabIdByGroupId).length === 0
    )
  }
  if (selection.activeTabId !== null && !eligible.tabIds.has(selection.activeTabId)) {
    return false
  }
  if (selection.activeGroupId !== null && !eligible.groupIds.has(selection.activeGroupId)) {
    return false
  }
  return Object.entries(selection.activeTabIdByGroupId).every(
    ([groupId, tabId]) => eligible.groupIds.has(groupId) && eligible.tabIds.has(tabId)
  )
}
