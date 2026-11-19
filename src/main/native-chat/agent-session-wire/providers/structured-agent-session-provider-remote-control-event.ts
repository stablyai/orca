import type { AgentSessionProviderRemoteControl } from '../../../../shared/agent-session/remote-control/agent-session-provider-remote-control'

/** The child's own remote link changed (Claude Code's Remote Control); memory-only, so it ends
 *  with the child that reported it. */
export type StructuredAgentSessionProviderRemoteControlEvent = {
  type: 'provider-remote-control'
  sessionId: string
  fence: number
  acquisitionGeneration: string
  remoteControl: AgentSessionProviderRemoteControl | null
}
