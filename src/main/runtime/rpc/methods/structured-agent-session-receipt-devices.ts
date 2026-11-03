import { isNativeChatLocalResolver } from '../../../../shared/native-chat/native-chat-resolution-receipt'
import type {
  AgentJournalRenderItem,
  AgentJournalResolution
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionAttachResult,
  AgentSessionHistoryPage,
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session/agent-session-wire'
import {
  BOUNDED_FRAME_CONTENT_BUDGET_BYTES,
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  historyContentBytes,
  measureHistoryItem,
  submissionBytesByItemId
} from '../../../native-chat/agent-session-wire/agent-session-history-page-bounds'
import type { RpcContext } from '../core'
import { structuredCallerFor } from './structured-agent-session-gate'

type ReceiptReader = Pick<RpcContext, 'runtime' | 'caller' | 'clientId' | 'clientKind'>

function resolverDevice(
  resolvedBy: string,
  ctx: ReceiptReader
): AgentJournalResolution['resolvedByDevice'] {
  const caller = structuredCallerFor(ctx).callerKey
  const local = isNativeChatLocalResolver(resolvedBy)
  if (resolvedBy === caller || (local && isNativeChatLocalResolver(caller))) {
    return { kind: 'current' }
  }
  const name = local ? ctx.runtime.readMachineName() : ctx.runtime.readPairedDeviceName(resolvedBy)
  return name?.trim() ? { kind: 'named', name } : undefined
}

/** Project every read afresh so historical receipts follow current pairing names. */
export function projectReceiptDeviceItem(
  item: AgentJournalRenderItem,
  ctx: ReceiptReader
): AgentJournalRenderItem {
  const { body } = item
  if ((body.kind !== 'question' && body.kind !== 'approval') || !body.resolution.resolvedBy) {
    return item
  }
  const resolvedByDevice = resolverDevice(body.resolution.resolvedBy, ctx)
  return { ...item, body: { ...body, resolution: { ...body.resolution, resolvedByDevice } } }
}

function projectItems(
  content: Pick<AgentSessionHistoryPage, 'items' | 'submissions' | 'removedItemIds'>,
  ctx: ReceiptReader,
  budgetBytes: number
): AgentJournalRenderItem[] {
  const items = content.items.map((item) => projectReceiptDeviceItem(item, ctx))
  if (items.every((item, index) => item === content.items[index])) {
    return content.items
  }
  const bytes = historyContentBytes(
    items.map(measureHistoryItem),
    content.removedItemIds,
    submissionBytesByItemId(content.submissions)
  )
  // Display metadata must not consume the envelope reserve or displace existing history.
  return bytes <= budgetBytes ? items : content.items
}

function projectPage(
  page: AgentSessionHistoryPage,
  ctx: ReceiptReader,
  budgetBytes = HISTORY_PAGE_CONTENT_BUDGET_BYTES
): AgentSessionHistoryPage {
  return { ...page, items: projectItems(page, ctx, budgetBytes) }
}

export function projectReceiptDeviceHistory(
  result: AgentSessionHistoryResult,
  ctx: ReceiptReader
): AgentSessionHistoryResult {
  return { ...result, page: projectPage(result.page, ctx) }
}

export function projectReceiptDeviceAttach(
  result: AgentSessionMutationResult<AgentSessionAttachResult>,
  ctx: ReceiptReader
): AgentSessionMutationResult<AgentSessionAttachResult> {
  return result.ok
    ? { ...result, value: { ...result.value, page: projectPage(result.value.page, ctx) } }
    : result
}

export function projectReceiptDeviceEvent(
  event: AgentSessionSubscribeEvent,
  ctx: ReceiptReader
): AgentSessionSubscribeEvent {
  const budgetBytes =
    ctx.clientKind === 'mobile'
      ? BOUNDED_FRAME_CONTENT_BUDGET_BYTES
      : HISTORY_PAGE_CONTENT_BUDGET_BYTES
  if (event.type === 'batch') {
    return {
      ...event,
      batch: {
        ...event.batch,
        items: projectItems(event.batch, ctx, budgetBytes)
      }
    }
  }
  if (event.type === 'snapshot' || event.type === 'reset') {
    return { ...event, page: projectPage(event.page, ctx, budgetBytes) }
  }
  return event
}
