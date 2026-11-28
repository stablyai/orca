import {
  getRegisteredSshState,
  listRegisteredSshTargets
} from '../../../../ssh/targets/ssh-target-registry'
import { getPublicSshState } from '../../../hosts/platform-probe/public-ssh-state'
import { defineMethod, defineStreamingMethod } from '../../core'
import {
  ClientEventsSubscribeParams,
  ClientEventsUnsubscribeParams
} from '../../../../../shared/rpc-contract/client-ui/client-events-params'
import { BROWSER_CLIENT_HOST_REQUEST_CAPABILITY } from '../../../../../shared/browser/client-hosting/browser-client-host-request-protocol'
import { getBrowserHostRequestRegistry } from '../../../browser-host/leases/browser-host-request-registry'
import { GOOGLE_SETUP_CARDS_CLIENT_CAPABILITY } from '../../../../../shared/google/google-connect-types'
import { registerGoogleCardRenderer } from '../../../../google/google-card-reach'
import {
  STRUCTURED_CHAT_START_TELEMETRY_CLIENT_CAPABILITY,
  STRUCTURED_CHAT_PROMPT_TELEMETRY_CLIENT_CAPABILITY
} from '../../../../../shared/agent-session/requests/structured-chat-dispatch-telemetry'
import { subscribeStructuredChatTelemetry } from '../../../../telemetry/structured-chat-dispatch'
import { structuredCallerFor } from '../structured-sessions/creation/structured-agent-session-gate'
import {
  AgentWorkspaceTracker,
  workspaceTeammateOf
} from '../../../../bots/team-share/agent-workspace-tracker'
import { hostClientEvent } from '../../../../bots/team-share/teammate-client-events'
import type { RuntimeClientEvent } from '../../../../../shared/remote-runtime/session-graph/runtime-client-events'

let clientEventSubscriptionSeq = 0

export const CLIENT_EVENT_METHODS = [
  defineStreamingMethod({
    name: 'runtime.clientEvents.subscribe',
    permission: 'workspace',
    share: 'not-shared',
    params: ClientEventsSubscribeParams,
    handler: async (params, ctx, emit) => {
      const { runtime, connectionId, clientKind, pairedDeviceId, clientCapabilities } = ctx
      const teammate = workspaceTeammateOf(ctx)
      // Built before this stream listens, so its re-reads run ahead of the events they decide.
      const tracker = teammate ? new AgentWorkspaceTracker(runtime, teammate) : null
      await tracker?.ready()
      if (ctx.signal?.aborted) {
        tracker?.dispose()
        return
      }
      const deliver = tracker
        ? tracker.orderedClientEvents(emit)
        : (event: RuntimeClientEvent) => {
            const kept = hostClientEvent(event)
            if (kept) {
              emit(kept)
            }
          }
      await new Promise<void>((resolve) => {
        // Mobile discards terminalSideEffects; filter per-OSC batch frames before they cross the relay.
        const unsubscribe = runtime.onClientEvent(
          (event) => {
            // Only a desktop keeps an agent CLI update list; a phone would search its query cache for nothing.
            // Phones keep no desktop sidebar lineage either, so a Dispatch write is noise there.
            if (
              (event.type === 'agentCliUpdateFinished' ||
                event.type === 'agentOrchestrationChanged') &&
              clientKind === 'mobile'
            ) {
              return
            }
            deliver(event)
          },
          { consumesTerminalSideEffects: clientKind !== 'mobile' }
        )
        // The server asks only the owner's computers to host a page no one placed.
        const unregisterHostVolunteer =
          params.browserHostRequests === true &&
          ctx.callerScope?.kind !== 'bot-share' &&
          clientKind === 'runtime' &&
          pairedDeviceId &&
          clientCapabilities?.includes(BROWSER_CLIENT_HOST_REQUEST_CAPABILITY)
            ? getBrowserHostRequestRegistry(runtime).register({ pairedDeviceId, emit })
            : undefined
        const unregisterCardRenderer =
          clientKind === 'runtime' &&
          clientCapabilities?.includes(GOOGLE_SETUP_CARDS_CLIENT_CAPABILITY)
            ? registerGoogleCardRenderer()
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
            unregisterCardRenderer?.()
            unsubscribeTelemetry?.()
            tracker?.dispose()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )

        // Listen before snapshotting to close the subscribe race and replay sleep state missed during disconnect.
        for (const event of runtime.getTerminalSleepClientEventSnapshot?.() ?? []) {
          deliver(event)
        }
        for (const event of runtime.getNativeChatLaunchDraftResolutionClientEventSnapshot?.() ??
          []) {
          deliver(event)
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
            // The host's SSH targets are its own, as `sshStateChanged` is.
            sshStates: teammate ? [] : sshStates,
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
    share: 'not-shared',
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
