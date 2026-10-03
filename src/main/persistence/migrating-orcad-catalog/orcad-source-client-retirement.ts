import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { parsePersistedAutomationHostFilter } from '../../../shared/automation-host-filter'
import { hostStableKey } from '../../../shared/automation-owner-key'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { OrcadMigrationClientStatePayload } from '../../../shared/orcad-migration-client-state'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS,
  type ClientHostedBrowserCloseIntent
} from '../../../shared/client-hosted-browser-close-intent'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  unqualifyOrcadMigrationOwnerKey
} from './orcad-source-scope'

export function assertOrcadMigrationClientStateRetired(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const clientState = manifest.payload.dormantState?.clientState
  if (!clientState) {
    return
  }
  const source = manifest.source
  const scope = createOrcadMigrationSourceScope({ source, catalog: manifest.payload })
  for (const [deviceId, selections] of Object.entries(
    clientState.mobileClientTabSelectionsByDeviceId ?? {}
  )) {
    for (const ownerKey of Object.keys(selections)) {
      if (state.mobileClientTabSelectionsByDeviceId?.[deviceId]?.[ownerKey] !== undefined) {
        throw new Error('orcad_migration_source_mobile_selection_reappeared')
      }
    }
  }
  const ui = state.ui
  if (
    clientState.uiRouting?.lastActiveWorktreeId &&
    orcadMigrationOwnerMatchesScope(ui.lastActiveWorktreeId, scope)
  ) {
    throw new Error('orcad_migration_source_ui_routing_reappeared')
  }
  const target = state.sshTargets.find((entry) => entry.id === source.sshTargetId)
  if (
    clientState.savedPortForwards &&
    (!target ||
      serializeOrcadMigrationValue(target.portForwards ?? []) !==
        serializeOrcadMigrationValue(clientState.savedPortForwards))
  ) {
    throw new Error('orcad_migration_source_saved_port_forwards_changed')
  }
  for (const intent of clientState.clientHostedBrowserCloseIntents ?? []) {
    const sourceIntents =
      state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment?.[
        intent.sourceEnvironmentId
      ]
    if (
      sourceIntents?.some(
        (entry) =>
          entry.browserPageId === intent.browserPageId && entry.worktreeId === intent.worktreeId
      )
    ) {
      throw new Error('orcad_migration_source_close_intent_reappeared')
    }
    const destinationIntents =
      state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment?.[
        manifest.destinationEnvironmentId ?? ''
      ]
    const transferred = destinationIntents?.find(
      (entry) =>
        entry.browserPageId === intent.browserPageId && entry.worktreeId === intent.worktreeId
    )
    if (
      !transferred ||
      serializeOrcadMigrationValue(transferred) !==
        serializeOrcadMigrationValue({
          browserPageId: intent.browserPageId,
          worktreeId: intent.worktreeId,
          closedAt: intent.closedAt
        })
    ) {
      throw new Error('orcad_migration_source_close_intent_missing')
    }
  }
}

export function retireOrcadMigrationClientState(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const clientState = manifest.payload.dormantState?.clientState
  if (!clientState) {
    return
  }
  const source = manifest.source
  const scope = createOrcadMigrationSourceScope({ source, catalog: manifest.payload })
  if (clientState.mobileClientTabSelectionsByDeviceId) {
    for (const [deviceId, captured] of Object.entries(
      clientState.mobileClientTabSelectionsByDeviceId
    )) {
      const selections = state.mobileClientTabSelectionsByDeviceId?.[deviceId]
      if (!selections) {
        continue
      }
      for (const ownerKey of Object.keys(captured)) {
        delete selections[ownerKey]
      }
      if (Object.keys(selections).length === 0) {
        delete state.mobileClientTabSelectionsByDeviceId?.[deviceId]
      }
    }
  }
  const target = state.sshTargets.find((entry) => entry.id === source.sshTargetId)
  if (target && clientState.savedPortForwards) {
    target.portForwards = structuredClone(clientState.savedPortForwards)
  }
  retireCloseIntents(state, clientState.clientHostedBrowserCloseIntents ?? [], manifest)
  rewriteDesktopUiForDestination(state, manifest, scope)
}

function retireCloseIntents(
  state: PersistedState,
  captured: readonly NonNullable<
    OrcadMigrationClientStatePayload['clientHostedBrowserCloseIntents']
  >[number][],
  manifest: OrcadMigrationManifest
): void {
  if (captured.length === 0) {
    return
  }
  const current = state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment ?? {}
  const next: Record<string, ClientHostedBrowserCloseIntent[]> = Object.fromEntries(
    Object.entries(current).map(([key, entries]) => [key, structuredClone(entries)])
  )
  const destinationEnvironmentId = manifest.destinationEnvironmentId
  if (!destinationEnvironmentId) {
    throw new Error('orcad_migration_source_close_intent_destination_invalid')
  }
  for (const intent of captured) {
    const sourceEntries = next[intent.sourceEnvironmentId] ?? []
    const sourceIndex = sourceEntries.findIndex(
      (entry) =>
        entry.browserPageId === intent.browserPageId && entry.worktreeId === intent.worktreeId
    )
    if (
      sourceIndex === -1 ||
      serializeOrcadMigrationValue(sourceEntries[sourceIndex]) !==
        serializeOrcadMigrationValue({
          browserPageId: intent.browserPageId,
          worktreeId: intent.worktreeId,
          closedAt: intent.closedAt
        })
    ) {
      throw new Error('orcad_migration_source_close_intent_changed')
    }
    sourceEntries.splice(sourceIndex, 1)
    if (sourceEntries.length === 0) {
      delete next[intent.sourceEnvironmentId]
    } else {
      next[intent.sourceEnvironmentId] = sourceEntries
    }
    const destinationEntries = next[destinationEnvironmentId] ?? []
    const existing = destinationEntries.find(
      (entry) =>
        entry.browserPageId === intent.browserPageId && entry.worktreeId === intent.worktreeId
    )
    if (existing) {
      if (
        serializeOrcadMigrationValue(existing) !==
        serializeOrcadMigrationValue({
          browserPageId: intent.browserPageId,
          worktreeId: intent.worktreeId,
          closedAt: intent.closedAt
        })
      ) {
        throw new Error('orcad_migration_close_intent_destination_conflict')
      }
      continue
    }
    if (destinationEntries.length >= MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS) {
      throw new Error('orcad_migration_close_intent_destination_capacity_exceeded')
    }
    destinationEntries.push({
      browserPageId: intent.browserPageId,
      worktreeId: intent.worktreeId,
      closedAt: intent.closedAt
    })
    next[destinationEnvironmentId] = destinationEntries
  }
  state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment = next
}

function rewriteDesktopUiForDestination(
  state: PersistedState,
  manifest: OrcadMigrationManifest,
  scope: ReturnType<typeof createOrcadMigrationSourceScope>
): void {
  const route = manifest.payload.dormantState?.clientState?.uiRouting
  const destinationEnvironmentId = manifest.destinationEnvironmentId
  if (!route || !destinationEnvironmentId) {
    return
  }
  if (
    route.lastActiveWorktreeId &&
    orcadMigrationOwnerMatchesScope(state.ui.lastActiveWorktreeId, scope)
  ) {
    state.ui.lastActiveWorktreeId = composeWorktreeHostIdentity(
      toRuntimeExecutionHostId(destinationEnvironmentId),
      route.lastActiveWorktreeId
    )
  }
  if (route.workspaceHostScope === 'local' && state.ui.workspaceHostScope === scope.hostId) {
    state.ui.workspaceHostScope = `runtime:${encodeURIComponent(destinationEnvironmentId)}`
  }
  if (route.visibleWorkspaceHostIds?.includes('local') && state.ui.visibleWorkspaceHostIds) {
    state.ui.visibleWorkspaceHostIds = state.ui.visibleWorkspaceHostIds.map((hostId) =>
      hostId === scope.hostId
        ? (`runtime:${encodeURIComponent(destinationEnvironmentId)}` as const)
        : hostId
    )
  }
  if (route.workspaceHostOrder?.includes('local')) {
    state.ui.workspaceHostOrder = (state.ui.workspaceHostOrder ?? []).map((hostId) =>
      hostId === scope.hostId
        ? (`runtime:${encodeURIComponent(destinationEnvironmentId)}` as const)
        : hostId
    )
  }
  if (route.manualRepoOrder) {
    const repoIds = new Set(route.manualRepoOrder.map((entry) => entry.repoId))
    state.ui.manualRepoOrder = (state.ui.manualRepoOrder ?? []).map((entry) =>
      entry.hostId === scope.hostId && repoIds.has(entry.repoId)
        ? { ...entry, hostId: `runtime:${encodeURIComponent(destinationEnvironmentId)}` as const }
        : entry
    )
  }
  if (route.showDotfilesByWorktree) {
    const next = { ...state.ui.showDotfilesByWorktree }
    for (const [ownerKey, enabled] of Object.entries(next)) {
      if (orcadMigrationOwnerMatchesScope(ownerKey, scope)) {
        delete next[ownerKey]
        next[
          `runtime:${encodeURIComponent(destinationEnvironmentId)}|${unqualifyOrcadMigrationOwnerKey(ownerKey)}`
        ] = enabled
      }
    }
    state.ui.showDotfilesByWorktree = next
  }
  if (route.automationHostFilter?.kind === 'host') {
    const current = parsePersistedAutomationHostFilter(state.ui.automationHostFilter)
    const sourceKey = hostStableKey({
      authority: { kind: 'desktop' },
      selector: { kind: 'ssh', targetId: scope.targetId }
    })
    if (current.kind === 'host' && hostStableKey(current.host) === sourceKey) {
      state.ui.automationHostFilter = structuredClone(route.automationHostFilter)
    }
  }
}
