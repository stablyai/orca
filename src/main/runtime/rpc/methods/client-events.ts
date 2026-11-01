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
    handler: async (_params, { runtime, connectionId, clientKind }, emit) => {
      await new Promise<void>((resolve) => {
        // Mobile discards terminalSideEffects; filter per-OSC batch frames before they cross the relay.
        const unsubscribe = runtime.onClientEvent(
          (event) => {
            emit(event)
          },
          { consumesTerminalSideEffects: clientKind !== 'mobile' }
        )

        const seq = ++clientEventSubscriptionSeq
        const subscriptionId = `runtime-client-events-${connectionId ?? 'inproc'}-${seq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )

        // Listen before snapshotting to close the subscribe race and replay sleep state missed during disconnect.
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
        // Listen before snapshotting to close reload gaps without exposing HUB-private target configuration.
        emit({
          type: 'ready',
          subscriptionId,
          snapshot: {
            sshStates,
            nativeChatQueueFollowUps: runtime.getClientSettings().nativeChatQueueFollowUps
          }
        })
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
