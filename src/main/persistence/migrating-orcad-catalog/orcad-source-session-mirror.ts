import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { extractSessionOwnersForTransfer } from '../../orca-profiles/profile-session-owner-transfer'
import { removeOwnedSessionState } from './orcad-source-workspace-session-retirement'
import { countUnrepresentableMarkdownState } from './orcad-source-workspace-session-eligibility'
import { collectOwnedTerminalTabIds } from './orcad-source-workspace-session-layout'
import {
  orcadMigrationOwnerMatchesScope,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

const focusFields = new Set([
  'activeWorktreeId',
  'activeWorkspaceKey',
  'activeTabId',
  'activeRepoId',
  'activeWorkspaceExecutionHostId'
])

function conflict(field?: string): never {
  throw new Error(`orcad_migration_source_live_mirror_conflict${field ? `:${field}` : ''}`)
}

function mergeTab(local: TerminalTab, host: TerminalTab): TerminalTab {
  const source = { ...local }
  const destination = { ...host }
  source.createdAt = destination.createdAt = Math.min(local.createdAt, host.createdAt)
  destination.customTitle = host.customTitle ?? local.customTitle
  destination.color = host.color ?? local.color
  delete source.pendingActivationSpawn
  delete destination.pendingActivationSpawn
  return mergeValue(source, destination, []) as TerminalTab
}

function mergeValue(local: unknown, host: unknown, path: string[]): unknown {
  if (local === undefined) {
    return structuredClone(host)
  }
  if (host === undefined) {
    return structuredClone(local)
  }
  if (serializeOrcadMigrationValue(local) === serializeOrcadMigrationValue(host)) {
    return structuredClone(local)
  }
  if (path.length === 1 && focusFields.has(path[0])) {
    return structuredClone(local ?? host)
  }
  if (
    path[0] === 'terminalTopologyRevisionByRepoId' &&
    path.length === 2 &&
    typeof local === 'number' &&
    typeof host === 'number'
  ) {
    return Math.max(local, host)
  }
  if (Array.isArray(local) && Array.isArray(host)) {
    if (!local.length) {
      return structuredClone(host)
    }
    if (!host.length) {
      return structuredClone(local)
    }
    if (path[0] === 'tabsByWorktree' && path.length === 2) {
      const localTabs = local as TerminalTab[]
      const hostTabs = host as TerminalTab[]
      if (
        new Set(localTabs.map((tab) => tab.id)).size !== localTabs.length ||
        new Set(hostTabs.map((tab) => tab.id)).size !== hostTabs.length
      ) {
        conflict()
      }
      return [
        ...localTabs.map((tab) => {
          const mirror = hostTabs.find((candidate) => candidate.id === tab.id)
          return mirror ? mergeTab(tab, mirror) : structuredClone(tab)
        }),
        ...hostTabs
          .filter((tab) => !localTabs.some((candidate) => candidate.id === tab.id))
          .map((tab) => structuredClone(tab))
      ]
    }
    conflict(path[0])
  }
  if (
    local &&
    host &&
    typeof local === 'object' &&
    typeof host === 'object' &&
    !Array.isArray(local) &&
    !Array.isArray(host)
  ) {
    const left = local as Record<string, unknown>
    const right = host as Record<string, unknown>
    return Object.fromEntries(
      [...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => [
        key,
        mergeValue(left[key], right[key], [...path, key])
      ])
    )
  }
  conflict(path[0])
}

/** Both live placements have already been authenticated; consolidate only the comparison clone. */
export function foldOrcadSourceSessionMirror(
  local: WorkspaceSessionState,
  host: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope
): { local: WorkspaceSessionState; host: WorkspaceSessionState } {
  if (countUnrepresentableMarkdownState(local, scope, false)) {
    conflict()
  }
  for (const tabId of collectOwnedTerminalTabIds(local, scope)) {
    if (
      local.remoteSessionIdsByTabId?.[tabId] ||
      local.closedTerminalTabTombstonesByTabId?.[tabId]
    ) {
      conflict('terminal-session-reference')
    }
  }
  for (const [owner, workspaces] of Object.entries(local.browserTabsByWorktree ?? {})) {
    if (!orcadMigrationOwnerMatchesScope(owner, scope)) {
      continue
    }
    // Extraction clears these bindings; refuse before it can erase their evidence.
    if (workspaces.some((workspace) => workspace.sessionProfileId || workspace.sessionPartition)) {
      conflict('browser-session-binding')
    }
  }
  const fragment = extractSessionOwnersForTransfer(local, {
    mapOwnerKey: (key) => (orcadMigrationOwnerMatchesScope(key, scope) ? key : null),
    mapWorktreeId: (key) => key,
    projectSessionFocus: ({ source, transferred, terminalTabIds }) => {
      if (source.activeRepoId && scope.repoIds.has(source.activeRepoId)) {
        transferred.activeRepoId = source.activeRepoId
      }
      if (source.activeTabId && terminalTabIds.has(source.activeTabId)) {
        transferred.activeTabId = source.activeTabId
      }
      if (source.activeWorkspaceExecutionHostId === scope.hostId) {
        transferred.activeWorkspaceExecutionHostId = scope.hostId
      }
    },
    projectSleepingAgentSession: (record) =>
      orcadMigrationOwnerMatchesScope(record.worktreeId, scope) ? structuredClone(record) : null
  })
  const merged = mergeValue(fragment, host, []) as WorkspaceSessionState
  for (const [owner, tabs] of Object.entries(merged.tabsByWorktree)) {
    if (orcadMigrationOwnerMatchesScope(owner, scope)) {
      for (const tab of tabs) {
        delete tab.pendingActivationSpawn
      }
    }
  }
  const remaining = removeOwnedSessionState(local, scope)
  if (remaining.activeRepoId && scope.repoIds.has(remaining.activeRepoId)) {
    remaining.activeRepoId = null
  }
  if (remaining.activeWorkspaceExecutionHostId === scope.hostId) {
    remaining.activeWorkspaceExecutionHostId = null
  }
  remaining.activeConnectionIdsAtShutdown = remaining.activeConnectionIdsAtShutdown?.filter(
    (id) => id !== scope.targetId
  )
  return { local: remaining, host: merged }
}
