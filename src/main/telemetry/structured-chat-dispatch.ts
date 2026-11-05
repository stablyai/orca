import type { AgentSessionJournalIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import { tuiAgentToAgentKind } from '../../shared/agent-kind'
import { isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import { track } from './client'

export function recordStructuredChatMessageDispatch(
  identity: AgentSessionJournalIdentity,
  state: 'accepted' | 'rejected'
): void {
  try {
    track('native_chat_message_sent', {
      semantics_version: 2,
      backend: 'structured',
      action: 'message',
      outcome: state === 'accepted' ? 'transport_acknowledged' : 'rejected',
      agent_kind: isTuiAgent(identity.agent) ? tuiAgentToAgentKind(identity.agent) : 'other',
      runtime:
        identity.hostId === 'local'
          ? 'local'
          : identity.hostId.startsWith('ssh:') || identity.hostId.startsWith('runtime:')
            ? 'remote'
            : 'unknown'
    })
  } catch {
    // A telemetry failure must not change the committed send outcome.
  }
}
