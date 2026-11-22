import * as z from 'zod'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import type { AccessRequestRedeemOutcome } from '../../../src/shared/bots/bot-link-resolution'

const redeemOutcomeSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('redeemed'), botId: z.string().min(1) }),
  z.looseObject({ kind: z.literal('not-here') }),
  z.looseObject({ kind: z.literal('not-owner') }),
  z.looseObject({ kind: z.literal('expired') }),
  z.looseObject({ kind: z.literal('unsupported') }),
  z.looseObject({ kind: z.literal('failed') })
])

const accessRequestRedeem = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.access.redeem-or-skip',
    method: 'bots.access.redeem',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-access-redeem', redeemOutcomeSchema)
  })
)

/** Asks one host to open an owner's "Review in Orca" link; the host spends the token only for a bot it has. */
export async function redeemBotAccessRequest(
  client: RpcClient,
  token: string
): Promise<AccessRequestRedeemOutcome> {
  try {
    const reply = accessRequestRedeem.interpret(
      await accessRequestRedeem.request(client, { token })
    )
    return reply.accepted ? reply.value : { kind: 'failed' }
  } catch {
    return { kind: 'failed' }
  }
}
