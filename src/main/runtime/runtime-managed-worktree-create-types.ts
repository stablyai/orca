import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import type { CreateWorktreeArgs } from '../../shared/worktree/create-types'
import type {
  AutomationWorkspaceProvenance,
  CliWorkspaceProvenance,
  GitPushTarget,
  WorkspaceLinkedItem,
  Worktree
} from '../../shared/worktree/types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../shared/workspace-source'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type { WorktreeStartupDraftPaste } from './runtime-worktree-agent-startup'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'

export type RuntimeManagedWorktreeCreateArgs = {
  repoSelector: string
  name: string
  nameWasGenerated?: boolean
  navigation?: RuntimeNavigationTarget
  baseBranch?: string
  compareBaseRef?: string
  branchNameOverride?: string
  linkedIssue?: number | null
  linkedPR?: number | null
  linkedLinearIssue?: string
  linkedLinearIssueWorkspaceId?: string | null
  linkedLinearIssueOrganizationUrlKey?: string | null
  linkedGitLabMR?: number | null
  linkedGitLabIssue?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  linkedWorkItem?: WorkspaceLinkedItem | null
  linkedTaskSourceContext?: TaskSourceContext | null
  comment?: string
  displayName?: string
  displayNameKind?: CreateWorktreeArgs['displayNameKind']
  telemetrySource?: WorkspaceCreateTelemetrySource
  workspaceStatus?: string
  manualOrder?: number
  sparseCheckout?: { directories: string[]; presetId?: string }
  pushTarget?: GitPushTarget
  runHooks?: boolean
  activate?: boolean
  setupDecision?: 'run' | 'skip' | 'inherit'
  awaitTerminalProvisioning?: boolean
  observeSetupCompletion?: boolean
  createdWithAgent?: TuiAgent
  startupAgent?: TuiAgent
  startupLaunchPreferences?: AgentLaunchPreferences
  startupPrompt?: string
  pendingFirstAgentMessageRename?: boolean
  automationProvenance?: AutomationWorkspaceProvenance
  cliProvenance?: CliWorkspaceProvenance
  creatorProvenance?: Worktree['creatorProvenance']
  startup?: WorktreeStartupLaunch
  startupDraft?: string
  startupDraftPaste?: WorktreeStartupDraftPaste
  lineage?: {
    parentWorkspace?: string
    parentWorkspaceOrigin?: 'manual'
    envParentWorkspace?: string
    parentWorktree?: string
    cwdParentWorktree?: string
    noParent?: boolean
    callerTerminalHandle?: string
    comment?: string
    orchestrationContext?: {
      parentWorktreeId?: string
      orchestrationRunId?: string
      taskId?: string
      coordinatorHandle?: string
    }
  }
}
