import { TERMINAL_SIDE_EFFECT_STATE_CAPABILITY } from '../../../../shared/terminal-transient-observation'
import {
  getRegisteredSshState,
  listRegisteredSshTargets
} from '../../../ssh/targets/ssh-target-registry'
import { getPublicSshState } from '../../public-ssh-state'
import { defineMethod, defineStreamingMethod } from '../core'
import { ClientEventsUnsubscribeParams } from '../../../../shared/rpc-contract/client-events-params'

let clientEventSubscriptionSeq = 0

export const CLIENT_EVENT_METHODS = [
  defineStreamingMethod({
    name: 'runtime.clientEvents.subscribe',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime, connectionId, clientKind, clientCapabilities }, emit) => {
      const terminalState =
        clientKind !== 'mobile' &&
        clientCapabilities?.includes(TERMINAL_SIDE_EFFECT_STATE_CAPABILITY) === true
      await new Promise<void>((resolve) => {
        // Mobile discards terminalSideEffects; filter per-OSC batch frames before they cross the relay.
        const seq = ++clientEventSubscriptionSeq
        const subscriptionId = `runtime-client-events-${connectionId ?? 'inproc'}-${seq}`
        const unsubscribe = runtime.onClientEvent(
          (event) => {
            if (
              event.type === 'terminalSideEffects' &&
              !terminalState &&
              event.batch.terminalState
            ) {
              const { terminalState: _state, ...batch } = event.batch
              if (batch.facts.length > 0) {
                emit({ ...event, batch })
              }
            } else {
              emit(event)
            }
          },
          {
            consumesTerminalSideEffects: clientKind !== 'mobile',
            initialize: () => {
              // Install the baseline before live callbacks and consumer-availability reentry.
              for (const event of runtime.getTerminalSleepClientEventSnapshot?.() ?? []) {
                emit(event)
              }
              for (const event of runtime.getNativeChatLaunchDraftResolutionClientEventSnapshot?.() ??
                []) {
                emit(event)
              }
              const sshStates = listRegisteredSshTargets().flatMap((target) => {
                const state = getPublicSshState(getRegisteredSshState(target.id) ?? null)
                return state ? [{ targetId: target.id, state }] : []
              })
              // The synchronous baseline/live cut does not expose private target configuration.
              emit({
                type: 'ready',
                subscriptionId,
                snapshot: {
                  sshStates,
                  nativeChatQueueFollowUps: runtime.getClientSettings().nativeChatQueueFollowUps,
                  ...(terminalState
                    ? { terminalSideEffects: runtime.getTerminalSideEffectClientEventSnapshot() }
                    : {})
                }
              })
            }
          }
        )

        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )
      })
    }
  }),
  defineMethod({
    name: 'runtime.clientEvents.unsubscribe',
    permission: 'workspace',
    params: ClientEventsUnsubscribeParams,
    handler: async (params, { runtime, connectionId }) => {
      const expectedPrefix = `runtime-client-events-${connectionId ?? 'inproc'}-`
      if (!params.subscriptionId.startsWith(expectedPrefix)) {
        return { unsubscribed: false }
      }
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
