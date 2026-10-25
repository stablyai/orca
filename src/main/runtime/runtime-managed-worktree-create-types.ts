import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import type { CreateWorktreeArgs } from '../../shared/worktree/create-types'
import type {
  AutomationWorkspaceProvenance,
  CliWorkspaceProvenance,
  GitPushTarget,
  WorkspaceLinkedItem,
  WorkspaceAttachment,
  Worktree
} from '../../shared/worktree/types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../shared/workspace-source'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type { WorktreeStartupDraftPaste } from './runtime-worktree-agent-startup'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type { RuntimeRepoSelector } from './runtime-repo-selector'

export type RuntimeManagedWorktreeCreateArgs = {
  repoSelector: RuntimeRepoSelector
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
  linkedItems?: WorkspaceAttachment[]
  linkedTaskSourceContext?: TaskSourceContext | null
  comment?: string
  displayName?: string
  displayNameKind?: CreateWorktreeArgs['displayNameKind']
  telemetrySource?: WorkspaceCreateTelemetrySource
  workspaceStatus?: string
  manualOrder?: number
  nestWorkspaces?: boolean
  refreshLocalBaseRefOnWorktreeCreate?: boolean
  localBaseRefSuggestionDismissed?: boolean
  sparseCheckout?: { directories: string[]; presetId?: string }
  pushTarget?: GitPushTarget
  runHooks?: boolean
  activate?: boolean
  setupDecision?: 'run' | 'skip' | 'inherit'
  setupOnly?: boolean
  awaitTerminalProvisioning?: boolean
  observeSetupCompletion?: boolean
  createdWithAgent?: TuiAgent
  /** Transient intent: this create will be followed by an agent chat surface. */
  promisedAgentChat?: boolean
  /** Keys the host's in-progress creation; minted when the caller sends none. */
  creationId?: string
  /** Main-internal launch registration before catalog notification or activation. */
  onWorkspaceCreated?: (worktreeId: string) => void
  startupAgent?: TuiAgent
  terminalImageViewerSupported?: boolean
  startupLaunchPreferences?: AgentLaunchPreferences
  startupPrompt?: string
  /** Main-only: caller delivers any uncarried startupPrompt through a compatible typed line and receives delivery status. */
  onStartupPromptCarry?: (carried: boolean) => void
  /** Per-launch inputs used when `startupAgent` is the created terminal surface. */
  startupAgentArgs?: string | null
  /** Main-internal: an automation's saved extras, merged over the startup agent's arguments. */
  startupExtraAgentArgs?: string
  /** Main-internal: Orca, not a user, types into the startup agent once it starts. */
  startupSuppressUpdatePrompt?: boolean
  startupCwd?: string
  /** The surface behind a host-built startup agent (`startupAgent` or `startupDraft`). */
  startupLaunchSource?: string
  /** A caller-minted `tabId:leafId` for the startup terminal's pane. */
  startupPaneKey?: string
  /** Account routing env merged over the startup agent's own env. */
  startupAccountEnv?: Record<string, string>
  pendingFirstAgentMessageRename?: boolean
  automationProvenance?: AutomationWorkspaceProvenance
  /** Host-only opt-in for user-initiated offline creates to use the remote base's named local branch; never sent over wire. */
  allowLocalBaseFallback?: boolean
  cliProvenance?: CliWorkspaceProvenance
  creatorProvenance?: Worktree['creatorProvenance']
  startup?: WorktreeStartupLaunch
  startupDraft?: string
  /** Reuse the launch-selected draft agent without changing caller-requested createdWithAgent. */
  startupDraftAgent?: TuiAgent
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
