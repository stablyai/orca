import { defineStreamingMethod } from '../../../core'
import { sendingTextAppends } from '../../../../../../shared/agent-session/agent-session-text-append'
import { recordMobileViewOpened } from '../../../../../telemetry/mobile-client-telemetry'
import { clientRequestsCommands } from '../structured-agent-session-policy'
import { clientReadsCurrentRequests } from '../conversation/structured-agent-session-current-requests'
import { clientSupportsSnapshotCatchUp } from '../history/structured-agent-session-history-capability'
import { projectBackgroundTaskEvent } from '../history/structured-agent-session-background-task-capability'
import { projectTurnItemEvent } from '../history/structured-agent-session-turn-item-capability'
import { requireInstalledStructuredHost as requireInstalledHost } from '../creation/structured-agent-session-gate'
import { bindStructuredAgentSessionStream } from './structured-agent-session-status-stream'
import { structuredAgentSessionSubscriptionId as subscriptionIdFor } from './structured-agent-session-subscription-id'
import { SubscribeParams } from '../../../../../../shared/rpc-contract/structured-agent-session-subscribe-params'
import * as queuedImages from '../attachments/structured-agent-session-queued-image-capability'
import { projectReceiptDeviceEvent } from './structured-agent-session-receipt-devices'

export const STRUCTURED_AGENT_SESSION_SUBSCRIBE_METHOD = defineStreamingMethod({
  name: 'agentSession.subscribe',
  permission: 'workspace',
  params: SubscribeParams,
  handler: async (params, ctx, emitFrame) => {
    const { capabilities } = params
    const emit =
      capabilities?.textAppend === 1 ? sendingTextAppends(emitFrame, capabilities) : emitFrame
    const host = await requireInstalledHost(ctx, params.sessionId)
    const subscriptionId = subscriptionIdFor(ctx, params.sessionId)
    // A stream reads; it never keeps an agent alive or starts one.
    let dispose = (): void => {}
    const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
    if (stream.isClosed()) {
      return
    }
    // Resolve after opening snapshot/missed batch; a racing close disposes the bound stream.
    dispose = await host.subscribe({
      commandsOnRequest: clientRequestsCommands(ctx),
      readsCurrentRequests: clientReadsCurrentRequests(ctx),
      id: subscriptionId,
      sessionId: params.sessionId,
      ...queuedImages.queuedImageSubscriber(ctx),
      projectQueuePublication: (publication) =>
        queuedImages.projectQueuedImageCardPublication(publication, ctx),
      emit: (event) =>
        emit(
          projectReceiptDeviceEvent(
            projectTurnItemEvent(
              projectBackgroundTaskEvent(event, ctx),
              ctx,
              host.sessionAgent(params.sessionId)
            ),
            ctx
          )
        ),
      end: (cause) => {
        if (stream.isClosed()) {
          return
        }
        console.warn('[agent-session] ending stream after a failed frame', params.sessionId, cause)
        try {
          emitFrame({ type: 'end' })
        } catch {
          // The transport is gone; releasing the stream below is all that is left to do.
        }
        stream.close()
      },
      ...(params.cursor ? { cursor: params.cursor } : {}),
      snapshotCatchUp: clientSupportsSnapshotCatchUp(ctx),
      // Every phone's app, whatever its version, ends a stream over a frame its bridge cannot carry.
      ...(ctx.clientKind === 'mobile' ? { boundedFrames: true } : {})
    })
    if (stream.isClosed()) {
      dispose()
      return
    }
    recordMobileViewOpened(ctx, {
      surface: 'chat',
      viewKey: `agentSession:${params.sessionId}`,
      agent: () => host.sessionAgent(params.sessionId)
    })
  }
})
