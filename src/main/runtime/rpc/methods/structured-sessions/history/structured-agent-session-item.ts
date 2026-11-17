// Negotiate item-detail.v1 for full journal items beyond preview heads; fit replies to transport limits and mark remaining truncation.

import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { ItemParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { shortenedAgentJournalItem } from '../../../../../native-chat/agent-session-wire/publication/history/agent-session-item-wire-form'
import { JOURNAL_ITEM_DETAIL_MAX_BYTES } from '../../../../../native-chat/agent-session-journal/journal-domain-item-wire'
import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'
import { projectReceiptDeviceItem } from '../subscriptions/structured-agent-session-receipt-devices'
import type { AutomationReceiptRead } from '../../../../../../shared/automations/automation-receipt-read'
import { readAutomationReceiptFacts } from '../../../../../../shared/automations/automation-receipt-facts'
import { automationForClient } from '../../../google-rules-for-client'
import type { Automation } from '../../../../../../shared/automations/automation-definition'

export const STRUCTURED_AGENT_SESSION_ITEM_METHODS = [
  defineMethod({
    name: 'agentSession.automationReceipt',
    permission: 'workspace',
    params: ItemParams,
    handler: async (params, ctx): Promise<AutomationReceiptRead> => {
      const host = await requireInstalledStructuredHost(ctx, params.sessionId, true)
      const receipt = await host.nativeAutomationReceipt(params.sessionId, params.itemId)
      if (!receipt) {
        return { status: 'unverified' }
      }
      const id = receipt.automation.id
      let automation: Automation
      try {
        automation = ctx.runtime.showAutomation(id)
      } catch (error) {
        if (error instanceof Error && error.message === 'Automation not found.') {
          return { status: 'missing' }
        }
        throw error
      }
      const owner = ctx.runtime.automationOwnerPrecondition(id)
      if (!owner) {
        return { status: 'unverified' }
      }
      const facts = readAutomationReceiptFacts(receipt.receiptFacts)
      if (
        !facts ||
        'unavailable' in facts ||
        automation.createdAt !== facts.automationCreatedAt ||
        automation.bot?.botId !== receipt.automation.bot?.botId
      ) {
        return { status: 'mismatch' }
      }
      return {
        status: 'ready',
        automation: automationForClient(automation, ctx),
        owner,
        effectiveZone: ctx.runtime.automationEffectiveTimeZone(automation)
      }
    }
  }),
  defineMethod({
    name: 'agentSession.item',
    permission: 'workspace',
    params: ItemParams,
    handler: async (params, ctx): Promise<{ item: AgentJournalRenderItem | null }> => {
      const item = await (
        await requireInstalledStructuredHost(ctx, params.sessionId, true)
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
