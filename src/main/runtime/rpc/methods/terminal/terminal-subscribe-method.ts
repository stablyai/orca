import { defineStreamingMethod, type RpcAnyMethod } from '../../core'
import { TerminalSubscribe } from './stream-schemas'
import { isTerminalReadPayloadIncomplete } from './terminal-stream-replay'
import { runTerminalBinarySubscription } from './terminal-legacy-subscribe-binary'
import {
  runTerminalJsonSubscription,
  runTerminalLeaseSubscription
} from './terminal-legacy-simple-subscriptions'
import type { TerminalSubscriptionArgs } from './terminal-legacy-subscription-types'

export const TERMINAL_SUBSCRIBE_METHODS: RpcAnyMethod[] = [
  // Streams live terminal output over WebSocket; mobile clients pass client+viewport for server-side auto-fit.
  defineStreamingMethod({
    name: 'terminal.subscribe',
    params: TerminalSubscribe,
    handler: async (
      params,
      { runtime, connectionId, sendBinary, registerBinaryStreamHandler, signal },
      emit
    ) => {
      let leaf = runtime.resolveLeafForHandle(params.terminal)
      const isMobile = params.client?.type === 'mobile'
      const serializerGenerationBeforeAnyMount = isMobile
        ? (runtime.getRendererTerminalSerializerGenerationForHandle?.(params.terminal) ?? 0)
        : 0
      let rendererMountRequestedBeforePty = false
      const useBinaryStream = params.capabilities?.terminalBinaryStream === 1 && Boolean(sendBinary)
      if (signal?.aborted) {
        return
      }

      if (!leaf?.ptyId && params.client) {
        rendererMountRequestedBeforePty = runtime.requestRendererTerminalTabMount(params.terminal)
        try {
          const ptyId = await runtime.waitForLeafPtyId(params.terminal, 10_000, signal)
          leaf = { ptyId }
        } catch {
          if (signal?.aborted) {
            return
          }
        }
      }
      if (!leaf?.ptyId) {
        const read = await runtime.readTerminal(params.terminal)
        emit({
          type: 'subscribed',
          streamId: null,
          lines: read.tail,
          truncated: isTerminalReadPayloadIncomplete(read)
        })
        emit({ type: 'end' })
        return
      }
      if (isMobile && (!useBinaryStream || !sendBinary)) {
        throw new Error('binary_terminal_stream_required')
      }

      const ptyId = leaf.ptyId
      const clientId = params.client?.id
      const missingHeadlessStateBeforeMobileFit =
        isMobile &&
        (rendererMountRequestedBeforePty || runtime.hasHeadlessTerminalState?.(ptyId) === false)
      const args: TerminalSubscriptionArgs = {
        params,
        runtime,
        connectionId,
        sendBinary,
        registerBinaryStreamHandler,
        signal,
        emit,
        ptyId,
        clientId,
        isMobile,
        supportsDesktopViewportClaims: params.capabilities?.desktopViewportClaims === 1,
        supportsWriteUnavailable: params.capabilities?.writeUnavailable === 1,
        rendererMountRequestedBeforePty,
        missingHeadlessStateBeforeMobileFit,
        serializerGenerationBeforeMobileFit: missingHeadlessStateBeforeMobileFit
          ? rendererMountRequestedBeforePty
            ? serializerGenerationBeforeAnyMount
            : runtime.getRendererTerminalSerializerGeneration(ptyId)
          : 0
      }
      if (isMobile && params.capabilities?.mobileInputLeaseOnly === 1 && Boolean(clientId)) {
        await runTerminalLeaseSubscription(args)
        return
      }
      if (!useBinaryStream) {
        await runTerminalJsonSubscription(args)
        return
      }
      await runTerminalBinarySubscription(args)
    }
  })
]
