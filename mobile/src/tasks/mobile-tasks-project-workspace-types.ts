import type {
  GitHubWorkItem,
  GitLabWorkItem,
  GitLabTodo,
  LinearIssue,
  SetupDecision
} from './mobile-tasks-provider-detail-types'
import type { WorkspaceAgentChoice, SparsePreset } from './mobile-tasks-dependencies'
import type { GitHubProjectRow } from './mobile-tasks-view-state-types'

export type TaskItem =
  | {
      key: string
      provider: 'github'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: GitHubWorkItem
    }
  | {
      key: string
      provider: 'gitlab'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: GitLabWorkItem
    }
  | {
      key: string
      provider: 'gitlabTodo'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: GitLabTodo
    }
  | {
      key: string
      provider: 'linear'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: LinearIssue
    }

export type ActionableTaskItem = Exclude<TaskItem, { provider: 'gitlabTodo' }>

export type HostedReviewMergeMethod = 'merge' | 'squash' | 'rebase'

export type HostedReviewItem =
  | Extract<TaskItem, { provider: 'github' }>
  | Extract<TaskItem, { provider: 'gitlab' }>

export type PendingHostedMerge = {
  item: HostedReviewItem
  method: HostedReviewMergeMethod
}

export type PendingProjectGitHubMerge = {
  row: GitHubProjectRow
  method: HostedReviewMergeMethod
}

export type PendingHostedStateChange =
  | {
      source: 'task'
      item: Extract<TaskItem, { provider: 'github' }> | Extract<TaskItem, { provider: 'gitlab' }>
      nextState: 'open' | 'opened' | 'closed'
    }
  | {
      source: 'project'
      row: GitHubProjectRow
      nextState: 'open' | 'closed'
    }

export type SetupPrompt = {
  item: ActionableTaskItem
  repoIdOverride?: string
  agentOverride?: WorkspaceAgentChoice
  workspaceNameOverride?: string
  noteOverride?: string
  baseBranchOverride?: string
  branchNameOverride?: string
  sparseCheckoutOverride?: { directories: string[]; presetId?: string }
  repoName: string
  command: string
  source: string | null
}

export type WorkspaceCreateArgs = {
  item: ActionableTaskItem
  repoIdOverride?: string
  setupOverride?: Exclude<SetupDecision, 'inherit'>
  agentOverride?: WorkspaceAgentChoice
  workspaceNameOverride?: string
  noteOverride?: string
  baseBranchOverride?: string
  branchNameOverride?: string
  sparseCheckoutOverride?: { directories: string[]; presetId?: string }
}

export type OrcaYamlTrustPrompt = WorkspaceCreateArgs & {
  repoId: string
  repoName: string
  scriptContent: string
  contentHash: string
  previouslyApproved: boolean
}

export type WorkspaceCreateDraft = {
  item: ActionableTaskItem
  repoIdOverride?: string
}

export type WorkspaceSparseDraft = {
  mode: 'new' | 'edit'
  presetId?: string
  name: string
  directoriesText: string
}

export function sortSparsePresetsByName(presets: SparsePreset[]): SparsePreset[] {
  return [...presets].sort((left, right) => left.name.localeCompare(right.name))
}

export function workspaceAgentIconId(agent: WorkspaceAgentChoice): string {
  return agent === 'blank' ? '__blank__' : agent
}

export type ProjectRepoNotInOrcaPrompt = {
  owner: string
  repo: string
  url: string | null
}

export type TaskListEntry =
  | { type: 'section'; key: string; label: string; color: string }
  | { type: 'item'; key: string; item: TaskItem }
