import type { AgentProviderSessionMetadata } from '../../../shared/agent-session/lifecycle/agent-session-resume'

export type LaunchResumeIdentityEvent = {
  paneKey: string
  worktreeId?: string
  agentType: string
  providerSession: AgentProviderSessionMetadata
  /** When the pane's process launched; a row reported since then is the agent's own. */
  launchedAt: number
}
