// Transitional: remove once no supported release lacks AGENT_SESSION_TURN_ITEM_CAPABILITY.
//
// A client that predates the `turn` item renders the unknown kind as a text bubble, so the
// host publishes the legacy status form to it at the RPC boundary only. The journal, the
// status feed, and every in-process reader keep the canonical body.

import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { legacyAgentJournalTurnStatusBody } from '../../../../shared/agent-session-turn-record'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'
import { AGENT_SESSION_TURN_ITEM_CAPABILITY } from '../../../../shared/protocol-version'
import type { RpcContext } from '../core'

type TurnItemReader = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

function readsTurnItems(ctx: TurnItemReader): boolean {
  // An in-process caller is this build; only a negotiated client can predate the item.
  return (
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(AGENT_SESSION_TURN_ITEM_CAPABILITY) === true
  )
}

function projectItems(items: AgentJournalRenderItem[]): AgentJournalRenderItem[] {
  if (!items.some((item) => item.body.kind === 'turn')) {
    return items
  }
  return items.map((item) => {
    if (item.body.kind !== 'turn') {
      return item
    }
    const { kind: _kind, ...turn } = item.body
    return { ...item, body: legacyAgentJournalTurnStatusBody(turn, item.itemId) }
  })
}

function projectPage(page: AgentSessionHistoryPage): AgentSessionHistoryPage {
  const items = projectItems(page.items)
  return items === page.items ? page : { ...page, items }
}

export function projectTurnItemHistory(
  result: AgentSessionHistoryResult,
  ctx: TurnItemReader
): AgentSessionHistoryResult {
  if (readsTurnItems(ctx)) {
    return result
  }
  const page = projectPage(result.page)
  return page === result.page ? result : { ...result, page }
}

export function projectTurnItemEvent(
  event: AgentSessionSubscribeEvent,
  ctx: TurnItemReader
): AgentSessionSubscribeEvent {
  if (readsTurnItems(ctx)) {
    return event
  }
  if (event.type === 'batch') {
    const items = projectItems(event.batch.items)
    return items === event.batch.items ? event : { ...event, batch: { ...event.batch, items } }
  }
  if (event.type === 'snapshot' || event.type === 'reset') {
    const page = projectPage(event.page)
    return page === event.page ? event : { ...event, page }
  }
  return event
}
