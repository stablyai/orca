import { TerminalSubscriptionParams } from '../../../../../../shared/rpc-contract/terminal-subscription-params'
import { defineMethod } from '../../../core'

export const ORCHESTRATION_SUBSCRIPTION_METHODS = [
  defineMethod({
    name: 'orchestration.subscribe',
    params: TerminalSubscriptionParams,
    handler: (
      _params,
      {
        runtime,
        orchestrationCompatibilityEvidence,
        recordMutationReceipt,
        replayedMutationReceipt
      }
    ) => {
      if (replayedMutationReceipt !== undefined) {
        return {
          ...runtime.terminalMailboxSubscription('status', orchestrationCompatibilityEvidence),
          historicalReplay: replayedMutationReceipt
        }
      }
      const receipt = runtime.terminalMailboxSubscription(
        'subscribe',
        orchestrationCompatibilityEvidence
      )
      recordMutationReceipt?.(receipt)
      return receipt
    }
  }),
  defineMethod({
    name: 'orchestration.unsubscribe',
    params: TerminalSubscriptionParams,
    handler: (
      _params,
      {
        runtime,
        orchestrationCompatibilityEvidence,
        recordMutationReceipt,
        replayedMutationReceipt
      }
    ) => {
      if (replayedMutationReceipt !== undefined) {
        return {
          ...runtime.terminalMailboxSubscription('status', orchestrationCompatibilityEvidence),
          historicalReplay: replayedMutationReceipt
        }
      }
      const receipt = runtime.terminalMailboxSubscription(
        'unsubscribe',
        orchestrationCompatibilityEvidence
      )
      recordMutationReceipt?.(receipt)
      return receipt
    }
  }),
  defineMethod({
    name: 'orchestration.subscriptionStatus',
    params: TerminalSubscriptionParams,
    handler: (_params, { runtime, orchestrationCompatibilityEvidence }) =>
      runtime.terminalMailboxSubscription('status', orchestrationCompatibilityEvidence)
  })
]
