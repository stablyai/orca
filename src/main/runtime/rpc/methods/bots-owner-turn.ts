import { requireStructuredHost } from '../../../bots/bot-chat-session'
import type { RpcContext } from '../core'

/** Whether the chat's latest message is its owner's own, not an automation run's, a connector's or Orca's. */
export async function ownerTypedLatest(runtime: RpcContext['runtime'], sessionId: string) {
  const reads = await (await requireStructuredHost(runtime)).journalReads(sessionId)
  const body = (await reads.promptItem('last'))?.body
  return body?.kind === 'message' && !body.from && !body.origin && !body.memorySource
}
