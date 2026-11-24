import { createLegacyProviderTimelineIdentityScheme } from '../../../native-chat/agent-session-timeline/provider-timeline-identity'
import {
  providerKey,
  ProviderTimelineRows
} from '../../../native-chat/agent-session-timeline/provider-timeline-rows'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AcpStructuredChild } from '../children/acp-structured-child'

/** More background calls than this outlasting their turns can't be real; the rest start anew. */
const MAX_CARRIED_CALLS = 32

/**
 * Calls still running in the background when the earlier app quit: their turns ended, so their
 * starts were acked and won't replay. Each saved row is carried before output is let through, so
 * the agent's later updates revise it instead of replacing it with a bare call.
 */
export async function carryKeptAcpCalls(
  child: AcpStructuredChild,
  agent: AgentType
): Promise<void> {
  const callIds = child.connection.kept?.openWork('task').slice(0, MAX_CARRIED_CALLS) ?? []
  const translator = child.lane?.translator
  const history = child.events?.journalHistory?.()
  if (callIds.length === 0 || !translator || !history) {
    return
  }
  const namespace = translator.providerSessionId
  const rows = new ProviderTimelineRows({
    scheme: createLegacyProviderTimelineIdentityScheme({ agent, sessionId: child.sessionId }),
    generation: '',
    namespace
  })
  const saved = await Promise.all(
    callIds.map((callId) => {
      const { itemId } = rows.item('item', providerKey(`tool:${callId}`), namespace)
      return history.readInOrder((reads) => reads.itemDetail(itemId)).catch(() => null)
    })
  )
  for (const row of saved) {
    if (row?.body.kind === 'tool-call') {
      translator.carryTool(row.body)
    }
  }
}
