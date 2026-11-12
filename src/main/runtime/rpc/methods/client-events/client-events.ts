import {
  getRegisteredSshState,
  listRegisteredSshTargets
} from '../../../../ssh/targets/ssh-target-registry'
import { getPublicSshState } from '../../../hosts/platform-probe/public-ssh-state'
import { defineMethod, defineStreamingMethod } from '../../core'
import {
  ClientEventsSubscribeParams,
  ClientEventsUnsubscribeParams
} from '../../../../../shared/rpc-contract/client-events-params'
import { BROWSER_CLIENT_HOST_REQUEST_CAPABILITY } from '../../../../../shared/browser/client-hosting/browser-client-host-request-protocol'
import { getBrowserHostRequestRegistry } from '../../../browser-host/leases/browser-host-request-registry'
import {
  STRUCTURED_CHAT_START_TELEMETRY_CLIENT_CAPABILITY,
  STRUCTURED_CHAT_PROMPT_TELEMETRY_CLIENT_CAPABILITY
} from '../../../../../shared/structured-chat-dispatch-telemetry'
import { subscribeStructuredChatTelemetry } from '../../../../telemetry/structured-chat-dispatch'
import { structuredCallerFor } from '../structured-sessions/creation/structured-agent-session-gate'

let clientEventSubscriptionSeq = 0

export const CLIENT_EVENT_METHODS = [
  defineStreamingMethod({
    name: 'runtime.clientEvents.subscribe',
    permission: 'workspace',
    params: ClientEventsSubscribeParams,
    handler: async (params, ctx, emit) => {
      const { runtime, connectionId, clientKind, pairedDeviceId, clientCapabilities } = ctx
      await new Promise<void>((resolve) => {
        // Mobile discards terminalSideEffects; filter per-OSC batch frames before they cross the relay.
        const unsubscribe = runtime.onClientEvent(
          (event) => {
            emit(event)
          },
          { consumesTerminalSideEffects: clientKind !== 'mobile' }
        )
        const unregisterHostVolunteer =
          params.browserHostRequests === true &&
          clientKind === 'runtime' &&
          pairedDeviceId &&
          clientCapabilities?.includes(BROWSER_CLIENT_HOST_REQUEST_CAPABILITY)
            ? getBrowserHostRequestRegistry(runtime).register({ pairedDeviceId, emit })
            : undefined
        const readsStarts = clientCapabilities?.includes(
          STRUCTURED_CHAT_START_TELEMETRY_CLIENT_CAPABILITY
        )
        const readsPrompts =
          ctx.caller?.kind === 'paired-device' &&
          clientKind === 'runtime' &&
          clientCapabilities?.includes(STRUCTURED_CHAT_PROMPT_TELEMETRY_CLIENT_CAPABILITY)
        const unsubscribeTelemetry =
          readsStarts || readsPrompts
            ? subscribeStructuredChatTelemetry((event, callerKey) => {
                if (
                  callerKey === structuredCallerFor(ctx).callerKey &&
                  (event.type === 'structuredChatPromptAccepted' ? readsPrompts : readsStarts)
                ) {
                  emit(event)
                }
              })
            : undefined

        const seq = ++clientEventSubscriptionSeq
        const subscriptionId = `runtime-client-events-${connectionId ?? 'inproc'}-${seq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            unregisterHostVolunteer?.()
            unsubscribeTelemetry?.()
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
        const settings = runtime.getClientSettings()
        // Listen before snapshotting to close reload gaps without exposing HUB-private target configuration.
        emit({
          type: 'ready',
          subscriptionId,
          snapshot: {
            sshStates,
            nativeChatQueueFollowUps: settings.nativeChatQueueFollowUps,
            nativeChatCiResultLines: settings.nativeChatCiResultLines
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
