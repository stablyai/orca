import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { AgentDotState } from '../worktree/agent-row-display'
import type {
  SectionRepo,
  Worktree,
  WorktreeHostContextView
} from '../worktree/workspace-list-types'
import type { ConversationHistory } from './conversation-records'

export type ConversationRow = {
  key: string
  title: string
  preview?: string
  agent: string | null
  status: AgentDotState | 'saved' | 'transcript'
  at: number
  workspace: Worktree | null
  workspaceContext?: WorktreeHostContextView
  executionHostId?: ExecutionHostId
  paneKey?: string
  preferenceKey?: string
  history?: ConversationHistory
}
export type ConversationProject = {
  key: string
  title: string
  hostId: ExecutionHostId
  hostLabel?: string
  hostHealthLabel?: string
  repo?: SectionRepo
  visibilityKey?: string
  workspaces: Worktree[]
  data: ConversationRow[]
}

export function projectConversationTarget(project: ConversationProject): Worktree | null {
  return (
    project.workspaces.find(
      (workspace) => workspace.isMainWorktree || workspace.workspaceKind === 'folder-workspace'
    ) ?? (project.workspaces.length === 1 ? project.workspaces[0] : null)
  )
}

export function folderOnlyConversationRepoKeys(
  workspaces: readonly Worktree[],
  hostOf: (workspace: Worktree) => ExecutionHostId
): ReadonlySet<string> {
  const folders = new Set(
    workspaces
      .filter((workspace) => workspace.workspaceKind === 'folder-workspace')
      .map((workspace) => `${hostOf(workspace)}\0${workspace.repoId}`)
  )
  for (const workspace of workspaces) {
    if (workspace.workspaceKind !== 'folder-workspace') {
      folders.delete(`${hostOf(workspace)}\0${workspace.repoId}`)
    }
  }
  return folders
}
