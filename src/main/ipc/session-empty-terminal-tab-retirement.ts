import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  captureEmptyTerminalTabRetirement,
  hasTerminalTabBindingOrHistory,
  isEmptyTerminalTabRetirementRequest,
  type EmptyTerminalTabRetirementResult
} from '../../shared/empty-terminal-tab-retirement'
import { closeTerminalTabInWorkspaceSession } from '../../shared/workspace-session-terminal-tab-close'
import { advanceTerminalTopologyRevision } from '../runtime/workspace-session-terminal-membership-authority'
import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost
} from '../../shared/worktree-execution-host-resolution'
import { resolveFolderWorkspaceHost } from '../../shared/folder-workspace-execution-host'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { parseExecutionHostId } from '../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { hasPendingTerminalTabOwner } from './pty/pane/empty-terminal-tab-retirement-owner'

function isLocalWorkspace(store: Store, worktreeId: string): boolean {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const state = {
      repos: store.getRepos(),
      folderWorkspaces: store.getFolderWorkspaces(),
      projectGroups: store.getProjectGroups()
    }
    const folder = state.folderWorkspaces.find((row) => row.id === scope.folderWorkspaceId)
    if (
      !folder ||
      (folder.executionHostId != null &&
        parseExecutionHostId(folder.executionHostId)?.kind !== 'local')
    ) {
      return false
    }
    return resolveFolderWorkspaceHost(state, scope.folderWorkspaceId).kind === 'local'
  }
  const resolved = resolveWorktreeExecutionHost(
    createRepoRowExecutionHostLookup(store.getRepos()),
    {
      repoId: getRepoIdFromWorktreeId(scope?.type === 'worktree' ? scope.worktreeId : worktreeId)
    }
  )
  return resolved.kind === 'resolved' && resolved.hostId === 'local'
}

export function retireEmptyTerminalTab(
  store: Store,
  runtime: Pick<OrcaRuntimeService, 'hasEmptyTerminalTabRetirementOwner'> | undefined,
  input: unknown
): EmptyTerminalTabRetirementResult {
  if (!isEmptyTerminalTabRetirementRequest(input)) {
    return { closed: false, reason: 'invalid-identity' }
  }
  const { worktreeId, tabId, createdAt, generation } = input
  if (!isLocalWorkspace(store, worktreeId)) {
    return { closed: false, reason: 'not-local' }
  }
  const session = store.getWorkspaceSession('local')
  if ((session.terminalTopologyRevisionByRepoId?.[getRepoIdFromWorktreeId(worktreeId)] ?? 0) <= 0) {
    return { closed: false, reason: 'renderer-owned-membership' }
  }
  const unifiedOwners = Object.values(session.unifiedTabs ?? {})
    .flat()
    .filter((row) => row.id === tabId || row.entityId === tabId)
  if (unifiedOwners.some((row) => row.structuredSessionId || row.viewMode === 'chat')) {
    return { closed: false, reason: 'structured-owner' }
  }
  const owners = Object.entries(session.tabsByWorktree).flatMap(([worktree, tabs]) =>
    tabs.filter((row) => row.id === tabId).map((row) => ({ worktree, row }))
  )
  if (owners.length > 1 || (owners[0] && owners[0].worktree !== worktreeId)) {
    return { closed: false, reason: 'different-owner' }
  }
  const current = captureEmptyTerminalTabRetirement(session, worktreeId, tabId)
  if (
    owners.length > 0 &&
    (!current || current.createdAt !== createdAt || current.generation !== generation)
  ) {
    return { closed: false, reason: 'stale-terminal' }
  }
  if (
    owners.length === 0 &&
    (unifiedOwners.length > 0 || hasTerminalTabBindingOrHistory(session, tabId))
  ) {
    return { closed: false, reason: 'unrepresented-owner' }
  }
  if (!runtime) {
    return { closed: false, reason: 'runtime-unavailable' }
  }
  if (
    runtime.hasEmptyTerminalTabRetirementOwner(worktreeId, tabId) ||
    hasPendingTerminalTabOwner(tabId)
  ) {
    return { closed: false, reason: 'runtime-owner' }
  }
  const closed = closeTerminalTabInWorkspaceSession(session, worktreeId, tabId)
  if (closed.pinned || closed.ptyIdsToKill.length > 0) {
    return { closed: false, reason: 'stale-terminal' }
  }
  // No await separates owner admission from the durable membership change.
  store.setWorkspaceSession(advanceTerminalTopologyRevision(closed.session, worktreeId), 'local')
  store.flushOrThrow()
  return { closed: true }
}
