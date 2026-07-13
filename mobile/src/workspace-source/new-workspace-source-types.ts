import type { GitHubPrStartPoint, GitHubWorkItem, LinearIssue } from '../../../src/shared/types'

export type NewWorkspaceSourceFilter = 'all' | 'github' | 'branches' | 'linear'

export type NewWorkspaceSourceRow =
  | { kind: 'github'; key: string; item: GitHubWorkItem }
  | {
      kind: 'branch'
      key: string
      refName: string
      localBranchName: string
      verified: boolean
    }
  | { kind: 'linear'; key: string; issue: LinearIssue }

export type ResolvedNewWorkspaceSource =
  | {
      kind: 'github'
      item: GitHubWorkItem
      suggestedName: string
      displayName: string
      prStartPoint?: GitHubPrStartPoint
      forkWarning: string | null
    }
  | {
      kind: 'branch'
      refName: string
      localBranchName: string
      verified: boolean
      branchAutoName: string
      branchNameOverride?: string
      reuseEligibleBranch: string | null
      reuseEnabled: boolean
    }
  | {
      kind: 'linear'
      issue: LinearIssue
      suggestedName: string
      displayName: string
      organizationUrlKey: string | null
    }

export type WorkspaceSourceAvailability = {
  github: boolean
  branches: boolean
  linear: boolean
}
