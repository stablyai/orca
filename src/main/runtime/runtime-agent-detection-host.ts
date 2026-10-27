import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { getRepoRoutingConnectionId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import {
  HOST_DEFAULT_AGENT_DETECTION,
  resolveWorkspaceAgentDetectionHost,
  type AgentDetectionHost,
  type WorkspaceAgentDetectionStore
} from '../preflight/workspace-agent-detection'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

type AgentDetectionContext = {
  store: WorkspaceAgentDetectionStore | null | undefined
  resolveRepo: (selector: string) => Promise<Repo>
  resolveWorktree: (selector: string) => Promise<ResolvedWorktree>
}

/** Resolve from the host's records, including the repo before a workspace exists. */
export async function resolveRuntimeAgentDetectionHost(
  context: AgentDetectionContext,
  worktreeId: string | null | undefined,
  repoId?: string
): Promise<AgentDetectionHost> {
  const { store } = context
  if (!store) {
    if (!worktreeId && repoId) {
      throw new Error('repo_not_found')
    }
    return HOST_DEFAULT_AGENT_DETECTION
  }
  if (!worktreeId && repoId) {
    const repo = await context.resolveRepo(`id:${repoId}`)
    const current = store.getRepos?.().filter((entry) => entry.id === repo.id) ?? []
    if (
      current.length !== 1 ||
      current[0].path !== repo.path ||
      current[0].executionHostId !== repo.executionHostId ||
      getRepoRoutingConnectionId(current[0]) !== getRepoRoutingConnectionId(repo)
    ) {
      throw new Error('repo_target_changed')
    }
    return resolveWorkspaceAgentDetectionHost(store, {
      kind: 'worktree',
      repoId: repo.id,
      path: repo.path
    })
  }
  if (!worktreeId || worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return HOST_DEFAULT_AGENT_DETECTION
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return resolveWorkspaceAgentDetectionHost(store, {
      kind: 'folder',
      folderWorkspaceId: scope.folderWorkspaceId
    })
  }
  let worktree: ResolvedWorktree
  try {
    worktree = await context.resolveWorktree(`id:${worktreeId}`)
  } catch (error) {
    // Only unknown workspaces retain the legacy default; an ambiguous owner must refuse.
    if (error instanceof Error && error.message === 'selector_not_found') {
      return HOST_DEFAULT_AGENT_DETECTION
    }
    throw error
  }
  return resolveWorkspaceAgentDetectionHost(store, {
    kind: 'worktree',
    repoId: worktree.repoId,
    path: worktree.path,
    hostId: worktree.hostId
  })
}
