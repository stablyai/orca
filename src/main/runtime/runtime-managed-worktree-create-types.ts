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
  linkedItems?: WorkspaceAttachment[]
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
  /** `--account <id|email>` for a `startupAgent: 'claude'` launch; resolved before any create. */
  startupClaudeAccount?: string
  startupPrompt?: string
  /** Main-internal: set by a caller that delivers an uncarried `startupPrompt` itself, so the text
   *  rides only a typed line that can carry it; reports whether it did. */
  onStartupPromptCarry?: (carried: boolean) => void
  /** Per-launch inputs used when `startupAgent` is the created terminal surface. */
  startupAgentArgs?: string | null
  startupCwd?: string
  /** The surface behind a host-built startup agent (`startupAgent` or `startupDraft`). */
  startupLaunchSource?: string
  /** A caller-minted `tabId:leafId` for the startup terminal's pane. */
  startupPaneKey?: string
  pendingFirstAgentMessageRename?: boolean
  automationProvenance?: AutomationWorkspaceProvenance
  /**
   * Host-side only, never on the wire: lets an offline create from a remote base use the local
   * branch it names. Only creates a person initiated opt in.
   */
  allowLocalBaseFallback?: boolean
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
