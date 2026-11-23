import { z } from 'zod'
import {
  LEGACY_JOURNAL_RETIREMENT_ACK_METHOD,
  LEGACY_JOURNAL_RETIREMENT_AVAILABLE,
  LEGACY_JOURNAL_RETIREMENT_CLAIM_METHOD,
  LEGACY_JOURNAL_RETIREMENT_FORWARDING_CAPABILITY
} from '../../../../../shared/remote-runtime/protocol/legacy-journal-retirement-forwarding'
import { legacyJournalRetirementForwarding } from '../../../../native-chat/agent-session-journal/journal-legacy-retirement-forwarding'
import { defineMethod, type RpcContext } from '../../core'

function retirementSubscriber(ctx: RpcContext, subscriptionId: string) {
  if (
    ctx.signal?.aborted ||
    !ctx.connectionId ||
    ctx.clientKind !== 'runtime' ||
    ctx.caller?.kind !== 'paired-device' ||
    ctx.caller.agent ||
    !ctx.clientCapabilities?.includes(LEGACY_JOURNAL_RETIREMENT_FORWARDING_CAPABILITY)
  ) {
    return undefined
  }
  return { connectionId: ctx.connectionId, deviceId: ctx.caller.deviceId, subscriptionId }
}

export function subscribeLegacyJournalRetirement(
  ctx: RpcContext,
  subscriptionId: string,
  emit: (event: unknown) => void
) {
  const subscriber = retirementSubscriber(ctx, subscriptionId)
  const forwarding = subscriber && legacyJournalRetirementForwarding(ctx.runtime)
  if (!subscriber || !forwarding) {
    return undefined
  }
  return {
    unsubscribe: forwarding.subscribe(subscriber, () =>
      emit({ type: LEGACY_JOURNAL_RETIREMENT_AVAILABLE })
    ),
    available: forwarding.available
  }
}

const ClaimParams = z.strictObject({
  subscriptionId: z.string().min(1).max(256),
  token: z.uuid()
})

export const LEGACY_JOURNAL_RETIREMENT_METHODS = [
  defineMethod({
    name: LEGACY_JOURNAL_RETIREMENT_CLAIM_METHOD,
    permission: 'workspace',
    params: ClaimParams.extend({ release: z.literal(true).optional() }),
    handler: ({ subscriptionId, token, release }, ctx) => {
      const subscriber = retirementSubscriber(ctx, subscriptionId)
      const forwarding = subscriber && legacyJournalRetirementForwarding(ctx.runtime)
      if (!subscriber || !forwarding) {
        return null
      }
      const request = { ...subscriber, token }
      return release ? forwarding.acknowledge(request, null) : forwarding.claim(request)
    }
  }),
  defineMethod({
    name: LEGACY_JOURNAL_RETIREMENT_ACK_METHOD,
    permission: 'workspace',
    params: z.discriminatedUnion('accepted', [
      ClaimParams.extend({ accepted: z.literal(false) }),
      ClaimParams.extend({ accepted: z.literal(true), deliveryId: z.uuid() })
    ]),
    handler: async (params, ctx) => {
      const { subscriptionId, token } = params
      const subscriber = retirementSubscriber(ctx, subscriptionId)
      return subscriber
        ? (await legacyJournalRetirementForwarding(ctx.runtime)?.acknowledge(
            { ...subscriber, token },
            params.accepted ? params.deliveryId : null
          )) === true
        : false
    }
  })
]
