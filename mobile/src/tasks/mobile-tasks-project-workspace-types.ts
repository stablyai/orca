import type { OrcaHookTrustPrompt } from '../components/hook-trust/OrcaHookTrustDrawer'
import type {
  GitHubWorkItem,
  GitLabWorkItem,
  GitLabTodo,
  GitPushTarget,
  SetupDecision
} from './mobile-tasks-provider-detail-types'
import type { LinearMobileIssue as LinearIssue } from './providers/linear/linear-mobile-issue-read'
import type { WorkspaceAgentChoice } from '../new-workspace/creation/workspace-agent-selection'
import type { SparsePreset } from '../../../src/shared/worktree/create-types'
import type { GitHubProjectRow } from './mobile-tasks-view-state-types'
import type { JiraIssue } from '../../../src/shared/jira/jira-types'

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
  | {
      key: string
      provider: 'jira'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: JiraIssue
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
  source: string | null | undefined
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
  /** The PR/MR start point whose setup was shown, so approval doesn't resolve it again. */
  hostedStartPoint?: HostedStartPoint
}

export type HostedStartPoint = { baseBranch: string; pushTarget?: GitPushTarget }

export type OrcaYamlTrustPrompt = WorkspaceCreateArgs &
  OrcaHookTrustPrompt & {
    /** The workspace exists; only its skipped setup is under review. Opening it ends the review. */
    created?: { worktreeId: string; open: (notice?: string) => void }
    /** An approval is saving or running; the drawer stays busy and ignores other choices. */
    approving?: true
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
