import * as z from 'zod'
import { ConnectorAccessRequest } from '../../../src/shared/connector-bot-access-contract'
import type { BotAccessDecision } from '../../../src/shared/connector-bot-access-contract'
import { salvagingArray } from '../../../src/shared/validation/zod-salvage'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'

// The host answers as BotSlackResult; a request it can't read is dropped, not the whole list.
const hostRefusal = z.looseObject({ ok: z.literal(false), error: z.string() })

export const botAccessRequestsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.access.list-or-skip',
    method: 'bots.access.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'bot-access-requests',
      z.union([
        z.looseObject({ ok: z.literal(true), value: salvagingArray(ConnectorAccessRequest) }),
        hostRefusal
      ])
    )
  })
)

const accessRequestDecide = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.access.decide',
    method: 'bots.access.decide',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'bot-access-decided',
      z.union([z.looseObject({ ok: z.literal(true) }), hostRefusal])
    )
  })
)

const DECIDE_FAILED_CODE = 'failed'

/** The host's answer to a Grant or Decline: ok, or the host's error code. */
export async function decideBotAccessRequest(
  client: RpcClient,
  requestId: string,
  decision: BotAccessDecision
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const answer = accessRequestDecide.interpret(
      await accessRequestDecide.request(client, { requestId, decision })
    )
    return answer.ok ? { ok: true } : { ok: false, error: answer.error }
  } catch {
    return { ok: false, error: DECIDE_FAILED_CODE }
  }
}
