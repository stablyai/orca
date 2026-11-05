import { finishJournalStepsAsync } from '../../../native-chat/agent-session-journal/journal-reconstruction-steps'
// Negotiate item-detail.v1 for full journal items beyond preview heads; fit replies to transport limits and mark remaining truncation.

import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { ItemParams } from '../../../../shared/rpc-contract/structured-agent-session-params'
import { shortenedAgentJournalItem } from '../../../native-chat/agent-session-wire/agent-session-item-wire-form'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../../shared/remote-runtime/remote-runtime-memory-limits'
import { defineMethod } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'
import { projectReceiptDeviceItem } from './structured-agent-session-receipt-devices'

/** The item's share of one reply, with room for the envelope beside it. */
const ITEM_REPLY_MAX_BYTES = REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES - 64 * 1024

export const STRUCTURED_AGENT_SESSION_ITEM_METHODS = [
  defineMethod({
    name: 'agentSession.item',
    permission: 'workspace',
    params: ItemParams,
    handler: async (params, ctx): Promise<{ item: AgentJournalRenderItem | null }> => {
      const snapshot = await (
        await requireInstalledStructuredHost(ctx, params.sessionId)
      ).journalSnapshot(params.sessionId)
      const item = await finishJournalStepsAsync(
        (function* () {
          for (const each of snapshot.items) {
            if (each.itemId === params.itemId) {
              return each
            }
            yield
          }
          return null
        })()
      )
      if (!item) {
        return { item: null }
      }
      // Null only for an item whose identifiers alone exceed a reply; the client keeps its head.
      return {
        item: shortenedAgentJournalItem(projectReceiptDeviceItem(item, ctx), ITEM_REPLY_MAX_BYTES)
      }
    }
  })
]
