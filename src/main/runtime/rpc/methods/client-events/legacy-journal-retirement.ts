import {
  LEGACY_JOURNAL_RETIREMENT_ACK_METHOD,
  LEGACY_JOURNAL_RETIREMENT_CLAIM_METHOD
} from '../../../../../shared/remote-runtime/protocol/legacy-journal-retirement-forwarding'
import {
  LegacyJournalRetirementAckParams,
  LegacyJournalRetirementClaimParams
} from '../../../../../shared/rpc-contract/client-ui/client-events-params'
import { legacyJournalRetirementForwarding } from '../../../../native-chat/agent-session-journal/journal-legacy-retirement-forwarding'
import { defineMethod } from '../../core'
import { legacyJournalRetirementSubscriber } from './client-events'

export const LEGACY_JOURNAL_RETIREMENT_METHODS = [
  defineMethod({
    name: LEGACY_JOURNAL_RETIREMENT_CLAIM_METHOD,
    permission: 'workspace',
    params: LegacyJournalRetirementClaimParams,
    handler: ({ subscriptionId, token, release }, ctx) => {
      const subscriber = legacyJournalRetirementSubscriber(ctx, subscriptionId)
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
    params: LegacyJournalRetirementAckParams,
    handler: async (params, ctx) => {
      const { subscriptionId, token } = params
      const subscriber = legacyJournalRetirementSubscriber(ctx, subscriptionId)
      return subscriber
        ? (await legacyJournalRetirementForwarding(ctx.runtime)?.acknowledge(
            { ...subscriber, token },
            params.accepted ? params.deliveryId : null
          )) === true
        : false
    }
  })
]
