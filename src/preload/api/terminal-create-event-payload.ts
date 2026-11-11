import type { RetainedTerminalStart } from '../../shared/workspace-layout/retained-terminal-start'
import type { NewGroupSplit } from '../../shared/workspace-layout/workspace-layout-command-types'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeTerminalPresentation } from '../../shared/runtime-terminal-contracts'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type { AgentLaunchTabViewerRule } from '../../shared/agent-launch/contracts/agent-launch-tab-publication'

export type TerminalCreateEventPayload = {
  requestId?: string
  worktreeId: string
  command?: string
  cwd?: string
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
  launchToken?: string
  launchAgent?: TuiAgent
  viewMode?: 'terminal' | 'chat'
  split?: NewGroupSplit
  targetGroupId?: string
  afterTabId?: string
  shellOverride?: string
  title?: string
  activate?: boolean
  focus?: boolean
  presentation?: RuntimeTerminalPresentation
  surfaceOwner?: false
  agentLaunchViewer?: AgentLaunchTabViewerRule
  tabId?: string
  leafId?: string
  splitFromLeafId?: string
  splitDirection?: 'horizontal' | 'vertical'
  splitTelemetrySource?: TerminalPaneSplitSource
} & (
  | { retainedTerminalStart?: never; ptyId?: string }
  | { retainedTerminalStart: RetainedTerminalStart; ptyId?: never; tabId: string; leafId: string }
)
