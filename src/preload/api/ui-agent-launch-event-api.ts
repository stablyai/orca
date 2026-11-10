import type {
  AgentLaunchChatFocus,
  AgentLaunchTabPublishReply,
  AgentLaunchTabPublishRequest
} from '../../shared/agent-launch/contracts/agent-launch-tab-publication'
import type { AgentLaunchPaneVerdictEvent } from '../../shared/agent-launch/contracts/agent-launch-pane-verdict'

/** What the host tells the window about the tabs of agents it launches. */
export type UiAgentLaunchEventApi = {
  onPublishAgentLaunchTab: (callback: (data: AgentLaunchTabPublishRequest) => void) => () => void
  replyAgentLaunchTabPublish: (reply: AgentLaunchTabPublishReply) => void
  onAgentLaunchPaneVerdict: (callback: (data: AgentLaunchPaneVerdictEvent) => void) => () => void
  // Older preloads lack this signal.
  onFocusAgentLaunchChat?: (callback: (data: AgentLaunchChatFocus) => void) => () => void
}
