// Negotiate item-detail.v1 for full journal items beyond preview heads; fit replies to transport limits and mark remaining truncation.

import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { ItemParams } from '../../../../../../shared/rpc-contract/structured-agent-session-params'
import { shortenedAgentJournalItem } from '../../../../../native-chat/agent-session-wire/publication/history/agent-session-item-wire-form'
import { JOURNAL_ITEM_DETAIL_MAX_BYTES } from '../../../../../native-chat/agent-session-journal/journal-domain-item-wire'
import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'
import { projectReceiptDeviceItem } from '../subscriptions/structured-agent-session-receipt-devices'

export const STRUCTURED_AGENT_SESSION_ITEM_METHODS = [
  defineMethod({
    name: 'agentSession.item',
    permission: 'workspace',
    params: ItemParams,
    handler: async (params, ctx): Promise<{ item: AgentJournalRenderItem | null }> => {
      const item = await (
        await requireInstalledStructuredHost(ctx, params.sessionId)
      ).historyItem(params.sessionId, params.itemId)
      if (!item) {
        return { item: null }
      }
      // Null only for an item whose identifiers alone exceed a reply; the client keeps its head.
      return {
        item: shortenedAgentJournalItem(
          projectReceiptDeviceItem(item, ctx),
          JOURNAL_ITEM_DETAIL_MAX_BYTES
        )
      }
    }
  })
]
