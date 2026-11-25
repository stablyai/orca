import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { agentSessionProviderHandleKey } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  nothingExchangedOn,
  type SavedProviderTurnReads
} from '../../native-chat/agent-session-journal/journal-provider-turn-saved'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'

export function buildAcpLaunchResume(
  head: AgentSessionProviderHandleLink | null | undefined,
  providerHandleChain: readonly AgentSessionProviderHandleLink[],
  savedSession: SavedProviderTurnReads,
  sessionId: string
): AcpStructuredLaunch['resume'] {
  if (!head) {
    return null
  }
  return {
    sessionId: head.handle.nativeId,
    key: agentSessionProviderHandleKey(head.handle),
    mayBeUnsaved: async () =>
      head.origin === 'created' &&
      (await nothingExchangedOn(savedSession, sessionId, head.handle.nativeId)),
    lossKeys: providerHandleChain.flatMap((link) =>
      link.replaces?.reason === 'restore-failed' ? [link.replaces.key] : []
    )
  }
}
