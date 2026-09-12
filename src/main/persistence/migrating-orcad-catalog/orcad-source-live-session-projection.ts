import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { parsePtyOwnershipTransferWireIdentity } from '../../../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'
import {
  orcadMigrationOwnerMatchesScope,
  unqualifyOrcadMigrationOwnerKey,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

/** Caller verifies provider ownership; this projects placement only, never leases or source state. */
export function projectOrcadSourceLiveSession(
  current: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope,
  values: readonly { identity: unknown; surfaceBinding: unknown }[]
): WorkspaceSessionState {
  const comparison = structuredClone(current)
  const panes = new Set<string>()
  const terminals = new Set<string>()
  const bridges = new Set<string>()
  const incarnations = new Set<string>()
  let destination: string | undefined
  for (const value of values) {
    const identity = parsePtyOwnershipTransferWireIdentity(value.identity)
    const binding = parsePtyOwnershipTransferSurfaceBinding(value.surfaceBinding)
    const workspace = parseWorkspaceKey(binding.workspaceKey)!
    const owner =
      workspace.type === 'folder' ? `folder:${workspace.folderWorkspaceId}` : workspace.worktreeId
    const pane = `${binding.tabId}:${binding.leafId}`
    const ptyId = toAppSshPtyId(scope.targetId, identity.terminalId)
    const matches = Object.entries(current.tabsByWorktree).flatMap(([key, tabs]) =>
      tabs.filter((tab) => tab.id === binding.tabId).map((tab) => ({ key, tab }))
    )
    const match = matches[0]
    const layout = current.terminalLayoutsByTabId[binding.tabId]
    const leaves = collectLayoutLeafIdsInOrder(layout?.root)
    if (
      binding.executionHostId !== 'local' ||
      binding.ptyId !== identity.terminalId ||
      (destination !== undefined && destination !== identity.destinationRuntimeId) ||
      panes.has(pane) ||
      terminals.has(identity.terminalId) ||
      bridges.has(identity.bridgeId) ||
      incarnations.has(identity.incarnationId) ||
      matches.length !== 1 ||
      !match ||
      !orcadMigrationOwnerMatchesScope(match.key, scope) ||
      [match.key, match.tab.worktreeId].some(
        (key) =>
          isWorktreeHostIdentity(key) &&
          getExecutionHostIdFromWorktreeHostIdentity(key) !== scope.hostId
      ) ||
      unqualifyOrcadMigrationOwnerKey(match.key) !== owner ||
      unqualifyOrcadMigrationOwnerKey(match.tab.worktreeId) !== owner ||
      leaves.filter((leaf) => leaf === binding.leafId).length !== 1 ||
      layout?.ptyIdsByLeafId?.[binding.leafId] !== ptyId ||
      current.terminalPtyIncarnationsByPaneKey?.[pane] !== identity.incarnationId ||
      current.terminalSurfaceTombstonesByPaneKey?.[pane] ||
      current.sleepingAgentSessionsByPaneKey?.[pane]
    ) {
      throw new Error('orcad_migration_source_live_projection_conflict')
    }
    destination = identity.destinationRuntimeId
    panes.add(pane)
    terminals.add(identity.terminalId)
    bridges.add(identity.bridgeId)
    incarnations.add(identity.incarnationId)
    delete comparison.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId![binding.leafId]
    delete comparison.terminalPtyIncarnationsByPaneKey![pane]
    const tab = comparison.tabsByWorktree[match.key].find((entry) => entry.id === binding.tabId)!
    if (tab.ptyId === ptyId) {
      tab.ptyId = null
    }
    if (comparison.remoteSessionIdsByTabId?.[binding.tabId] === ptyId) {
      delete comparison.remoteSessionIdsByTabId[binding.tabId]
    }
  }
  return comparison
}
