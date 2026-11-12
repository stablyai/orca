import type {
  WorkspaceSourceLinkedItem as MobileLinkedWorkItem,
  WorkspaceSourceSelection
} from '../../../../src/shared/new-workspace/workspace-source'
import type { GitPushTarget as WorkspaceCreateGitPushTarget } from '../../../../src/shared/worktree/types'

export type ComposerBaseState = {
  baseBranch?: string
  compareBaseRef?: string
  pushTarget?: WorkspaceCreateGitPushTarget
  branchNameOverride?: string
}

// Linear selections retain workspace/org routing needed to relink the issue at create time.

export type SmartNameSelectionKind =
  | 'github-pr'
  | 'github-issue'
  | 'gitlab-mr'
  | 'gitlab-issue'
  | 'branch'
  | 'linear'
  | 'jira'

export type SmartNameSelection = Omit<WorkspaceSourceSelection, 'kind'> & {
  kind: SmartNameSelectionKind
}

export type MrStateFilter = 'opened' | 'merged' | 'closed' | 'all'

export type MobileComposerCreateSelection =
  | {
      kind: 'work-item'
      item: MobileLinkedWorkItem
      baseBranch?: string
      compareBaseRef?: string
      pushTarget?: WorkspaceCreateGitPushTarget
      branchNameOverride?: string
    }
  | {
      kind: 'branch'
      baseBranch: string
      refName: string
      localBranchName: string
      reuse: boolean
      branchNameOverride?: string
    }
  // New-by-name branches start at the default base and preserve the typed branch name verbatim.
  | { kind: 'new-branch'; branchName: string }
