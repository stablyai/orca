import type { PreparedPaneReplacement } from '../recovery/prepared-pane-replacement'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/launch-types'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch/startup/agent-launch-runtime'
import type { SessionOptionValue } from '../../../../shared/native-chat/input/native-chat-session-options'
import type {
  AgentLaunchPreferences,
  AgentSessionExecutionClaim
} from '../../../../shared/agent-session/agent-session-host-authority'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal/protocol/queries/terminal-osc-color-reply'
import type { RuntimeTerminalPresentation } from '../../../../shared/runtime-terminal-contracts'
import type { AgentLaunchTabViewerRule } from '../../../../shared/agent-launch/contracts/agent-launch-tab-publication'
import type { SpawnIntent } from '../../../../shared/terminal/pty/admission/spawn-admission-contract'
import type { NewGroupSplit } from '../../../../shared/workspace-layout/workspace-layout-command-types'

export type TerminalCreateOptions = {
  preparedReplacement?: PreparedPaneReplacement
  command?: string
  /** Spawn Windows shell as the PTY process; selecting it through command creates only a child and later returns to the unwanted default shell. */
  shellOverride?: string
  claudeAgentTeamsSourceCommand?: string
  cwd?: string
  /** The caller's own measured pane size; wins over the group's measured size and the 120x40 fallback. */
  initialSize?: { cols: number; rows: number }
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: WorktreeStartupLaunch['launchConfig']
  resumeProviderSession?: AgentProviderSessionMetadata
  /** `saved`: built from a pane's saved facts, which the host refuses for a chat's conversation. */
  resumeOrigin?: 'saved'
  launchToken?: string
  launchAgent?: TuiAgent
  trustWorktreeId?: string
  startupAgent?: TuiAgent
  /** Offer initial text only to compatible startupAgent launch commands; otherwise refuse instead of silently dropping it.
   * Typed-line carry gates delivery; onStartupPromptCarry reports clean launches whose later delivery belongs to the live PTY owner. */
  startupPrompt?: string
  /** TEMPORARY createAgentSession parity: draft populates the unsent composer via flag/env and bypasses typed-line carry; remove with unified delivery policy. */
  startupPromptDelivery?: 'auto-submit' | 'draft'
  /** TEMPORARY createAgentSession parity: force-line carries any size or launches clean for post-start-only agents; remove when uncarried prompts gain later delivery. */
  startupPromptCarry?: 'force-line'
  /** Main-internal: whether `startupPrompt` rode the launch command. Called once the plan is built. */
  onStartupPromptCarry?: (carried: boolean) => void
  /** Override Settings arguments for this agent (null means none); plan input is not a caller-supplied command and does not take launch ownership. */
  agentArgs?: string | null
  extraAgentArgs?: string
  /** Main-internal: Orca, not a user, types into this `startupAgent` once it starts. */
  suppressStartupUpdatePrompt?: boolean
  /** Host-only runtime fact used to quote this launch; spawn must take its shell from that same fact, never client input. */
  launchRuntime?: AgentLaunchRuntime
  /** Account routing env merged over `startupAgent`'s plan env; an input to that plan, like
   *  `agentArgs`, so not part of `callerSuppliedLaunch`. */
  accountEnv?: Record<string, string>
  sessionOptions?: Readonly<Record<string, SessionOptionValue>>
  launchPreferences?: AgentLaunchPreferences
  terminalKittyKeyboardProtocol?: boolean
  terminalImageViewerSupported?: boolean
  terminalColorQueryReplies?: TerminalOscColorQueryReplyColors
  /** Unvalidated wire value: the creator's palette and cursor, pinned with its colours on a windowed host. */
  terminalViewAttributes?: unknown
  viewMode?: 'terminal' | 'chat'
  /** The tab group a background create joins; defaults to the first group. */
  targetGroupId?: string
  split?: NewGroupSplit
  /** Main-internal placement anchor; removed before PTY dispatch. */
  afterTabId?: string
  startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
  telemetry?: WorktreeStartupLaunch['telemetry']
  /** Attribute host-built startupAgent launches by surface; missing/unknown surface becomes unknown. Ignore without startupAgent. */
  launchSource?: string
  title?: string
  focus?: boolean
  activate?: boolean
  presentation?: RuntimeTerminalPresentation
  surfaceOwner?: false
  /** Main-internal: recheck early publication when the host is ready to reveal its pane. */
  agentLaunchViewer?: () => AgentLaunchTabViewerRule
  tabId?: string
  leafId?: string
  /** Layout-owner build: a pane this create writes stays when its start fails, showing why. */
  keepPaneOnStartFailure?: true
  /** With `keepPaneOnStartFailure`: a start already known to fail; only its pane is written. */
  startFailure?: Error
  /** Main-owned sleep wake publishes resume outcomes instead of relying on window restore. */
  resumesSleepingRecord?: true
  /** May start an existing pane again rather than new work in the workspace: a saved pane's
   *  restore, a lost pane's recovery, or a paired window mounting its panes. */
  reopensPane?: true
  /** Refuse, rather than attach, when `tabId`/`leafId` name a pane whose PTY is already live. */
  requireFreshPane?: boolean
  sessionId?: string
  isNewSession?: boolean
  preAllocatedHandle?: string
  persistHostSessionBinding?: boolean
  agentSessionClaim?: AgentSessionExecutionClaim
  agentSessionCreateOperationId?: string
  /** The paired client's declared intent; the host's fork gate validates and may defer it. */
  spawnIntent?: SpawnIntent
  /** The user's own act (a CLI command, a paired client's create, a launch); without it a stopped WSL distro holds the start. */
  wslUserAct?: true
  signal?: AbortSignal
  /** Refuse (`worktree_terminals_sleeping`) instead of waking a worktree the host has put to sleep. */
  refuseSleptWorktree?: boolean
  onPtySpawnCommitted?: () => void
  /** Called before the spawn request leaves this process; a throw before it proves nothing spawned. */
  onPtySpawnDispatched?: (launch?: {
    launchConfig?: SleepingAgentLaunchConfig
    launchAgent?: TuiAgent
  }) => void
  deferMobileSessionPublish?: boolean
}
