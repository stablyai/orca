// A shared agent's workspaces on this host: its home and every workspace its lineage nests under it
// (its workers' worktrees and theirs), by the same parent rules that name a `worktree.ps` row's bot.
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import {
  folderWorkspaceKey,
  workspaceKeyOfRow,
  worktreeWorkspaceKey,
  type WorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import type { Worktree } from '../../../../shared/worktree/types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { botHomeLookup } from './runtime-worktree-ps-summaries'

export type AgentWorkspaceSet = {
  homeKey: WorkspaceKey
  keys: ReadonlySet<WorkspaceKey>
  /** The repos its worktrees are checkouts of. */
  repoIds: ReadonlySet<string>
  /** The project groups its repos and folders sit in. */
  groupIds: ReadonlySet<string>
}

/** Null when the bot is not on this host. */
export function collectAgentWorkspaceSet(
  store: RuntimeStore | null,
  worktrees: readonly Worktree[],
  botId: string
): AgentWorkspaceSet | null {
  const bot = store?.getBots?.().find((entry) => entry.id === botId)
  if (!bot) {
    return null
  }
  const homeKey = folderWorkspaceKey(bot.folderWorkspaceId)
  const homeOf = botHomeLookup(store, worktrees)
  const keys = new Set<WorkspaceKey>([homeKey])
  const repoIds = new Set<string>()
  const groupIds = new Set<string>()
  for (const worktree of worktrees) {
    const key = worktreeWorkspaceKey(worktree.id)
    if (homeOf(key, worktree) === homeKey) {
      keys.add(key)
      repoIds.add(worktree.repoId)
    }
  }
  for (const folder of store?.getFolderWorkspaces?.() ?? []) {
    const key = folderWorkspaceKey(folder.id)
    if (homeOf(key, folderWorkspaceToWorktree(folder)) === homeKey) {
      keys.add(key)
      groupIds.add(folder.projectGroupId)
    }
  }
  for (const repo of store?.getRepos() ?? []) {
    if (repoIds.has(repo.id)) {
      if (repo.projectGroupId) {
        groupIds.add(repo.projectGroupId)
      }
    }
  }
  return { homeKey, keys, repoIds, groupIds }
}

/** Whether `id` (a row id, a bare worktree id or a workspace key) is one of the agent's workspaces. */
export function agentHasWorkspace(set: AgentWorkspaceSet, id: string | null | undefined): boolean {
  return id ? set.keys.has(workspaceKeyOfRow(id)) : false
}
