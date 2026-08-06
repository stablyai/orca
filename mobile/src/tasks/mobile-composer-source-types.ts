import type { SmartNameMode } from '../../../src/shared/new-workspace/smart-workspace-source-results'
import type {
  WorkspaceSourceLinkedItem,
  WorkspaceSourceSelection
} from '../../../src/shared/new-workspace/workspace-source'
import type { WorkspaceCreateGitPushTarget } from './workspace-create-params'

export type { SmartNameMode }

export type ComposerBaseState = {
  baseBranch?: string
  compareBaseRef?: string
  pushTarget?: WorkspaceCreateGitPushTarget
  branchNameOverride?: string
}

// Mirrors the desktop composer's `linkedWorkItem` (a FolderWorkspaceLinkedTask
// superset): the one work item a Smart selection pins the workspace to. Linear
// items carry the workspace/org routing the runtime needs to relink the issue.
export type MobileLinkedWorkItem = Omit<WorkspaceSourceLinkedItem, 'provider'> & {
  provider: Exclude<WorkspaceSourceLinkedItem['provider'], 'jira'>
}

export type SmartNameSelectionKind =
  | 'github-pr'
  | 'github-issue'
  | 'gitlab-mr'
  | 'gitlab-issue'
  | 'branch'
  | 'linear'

// The pill descriptor the field renders once a source is selected. Same shape
// as desktop's `SmartWorkspaceNameSelection`.
export type SmartNameSelection = Omit<WorkspaceSourceSelection, 'kind'> & {
  kind: SmartNameSelectionKind
}

// GitLab MR-state filter chips, mirroring desktop's getMrStateFilters(). Default
// is 'opened' (Open).
export type MrStateFilter = 'opened' | 'merged' | 'closed' | 'all'

// The resolved selection the create flow consumes. Work-item selections carry
// the base/push fields the composer resolved at select time; branch selections
// carry the ref + reuse intent.
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
  // A brand-new branch created by name (no ref picked); the branch is created off
  // the repo's default base and the typed name is kept verbatim as the branch.
  | { kind: 'new-branch'; branchName: string }
