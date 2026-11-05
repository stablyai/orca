import { settleTestSubscriberDeliveries } from '../native-chat/agent-session-wire/agent-session-subscriber-test-support'
import type { RpcRequest, RpcResponse } from './rpc/core'
import type { RpcDispatcher } from './rpc/dispatcher'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session/agent-session-wire'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

export function leaseOf(sessionId: string) {
  const record = getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)
  if (!record) {
    throw new Error(`Missing structured session record: ${sessionId}`)
  }
  return record.lease
}

export function itemsOf(frames: AgentSessionSubscribeEvent[]): AgentJournalRenderItem[] {
  const items = new Map<string, AgentJournalRenderItem>()
  for (const frame of frames) {
    const rows =
      frame.type === 'snapshot' || frame.type === 'reset'
        ? frame.page.items
        : frame.type === 'batch'
          ? frame.batch.items
          : []
    for (const row of rows) {
      items.set(row.itemId, row)
    }
  }
  return [...items.values()]
}

export function textOf(item: AgentJournalRenderItem): string {
  return item.body?.kind === 'message'
    ? item.body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
    : ''
}

export async function callStructuredSessionTestRpc(
  dispatcher: RpcDispatcher,
  requestId: string,
  method: string,
  params: unknown,
  client: { clientKind: 'runtime'; clientCapabilities: string[] }
): Promise<RpcResponse> {
  const replies: RpcResponse[] = []
  const request: RpcRequest = { id: requestId, authToken: 'token', method, params }
  await dispatcher.dispatchStreaming(request, (raw) => replies.push(JSON.parse(raw)), client)
  if (!replies[0]) {
    throw new Error(`no reply for ${method}`)
  }
  return replies[0]
}

export async function flushStructuredSessionTestEvents(sessionId: string): Promise<void> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('Missing structured session host')
  }
  await host.flushStreamedEvents(sessionId)
  await settleTestSubscriberDeliveries(host.collaboratorsForTests().subscribers)
}
