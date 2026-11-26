import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { FeishuStore } from './feishu-store-ops'
import type { Binding } from './feishu-binding'

export async function handoffFeishuResponse(
  runtime: OrcaRuntimeService,
  store: FeishuStore,
  binding: Binding,
  external: string,
  original: string,
  chat: string
): Promise<void> {
  const host = getStructuredAgentSessionHost()
  const linked = runtime
    .getExternalConversationSeam()
    ?.linkedChat({ source: 'feishu-local', externalId: external }, binding.bot)
  if (!host || !linked) {
    return
  }
  const rows = await host.deps.store.connectorReplies().read(linked.sessionId)
  const row = rows.find((r) => r.account === binding.account && r.deliveryId === original)
  if (!row) {
    return
  }
  const reads = await host.journalReads(linked.sessionId)
  const submission = await reads.submission(row.messageId)
  const joined = submission?.answeredInTurn
  if (submission?.dispatchState !== 'accepted' || joined?.via !== 'steer') {
    return
  }
  const turn = await reads.item(joined.turnItemId)
  const opener =
    turn?.body.kind === 'turn' && turn.body.userItemId
      ? await reads.item(turn.body.userItemId)
      : null
  const stamp =
    opener?.body.kind === 'message' && opener.body.role === 'user'
      ? opener.body.connectorDelivery
      : undefined
  if (
    !stamp ||
    stamp.account !== binding.account ||
    stamp.conversation.source !== 'feishu-local' ||
    stamp.conversation.externalId !== external
  ) {
    return
  }
  await store.updateResponse(binding.account, external, original, chat, {
    kind: 'handoff',
    from: stamp.deliveryId,
    turnItemId: joined.turnItemId,
    at: Date.now()
  })
}
