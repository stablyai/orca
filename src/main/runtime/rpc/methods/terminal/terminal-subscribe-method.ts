import { defineStreamingMethod } from '../../core'
import { TerminalSubscribe } from './stream-schemas'
import { isTerminalReadPayloadIncomplete } from './terminal-stream-replay'
import { runTerminalBinarySubscription } from './terminal-legacy-subscribe-binary'
import {
  runTerminalJsonSubscription,
  runTerminalLeaseSubscription
} from './terminal-legacy-simple-subscriptions'
import type { TerminalSubscriptionArgs } from './terminal-legacy-subscription-types'
import { registerTerminalSubscription } from './terminal-subscription-registration'

export const TERMINAL_SUBSCRIBE_METHODS = [
  // Streams live terminal output over WebSocket; mobile clients pass client+viewport for server-side auto-fit.
  defineStreamingMethod({
    name: 'terminal.subscribe',
    params: TerminalSubscribe,
    handler: async (
      params,
      { runtime, connectionId, sendBinary, registerBinaryStreamHandler, signal },
      emit
    ) => {
      const isMobile = params.client?.type === 'mobile'
      const useBinaryStream = params.capabilities?.terminalBinaryStream === 1 && Boolean(sendBinary)
      // Why: validated before registering, so a request that can never stream can't evict the slot's live stream.
      if (isMobile && !useBinaryStream) {
        throw new Error('binary_terminal_stream_required')
      }
      if (signal?.aborted) {
        return
      }
      let leaf = runtime.resolveLeafForHandle(params.terminal)
      const serializerGenerationBeforeAnyMount = isMobile
        ? (runtime.getRendererTerminalSerializerGenerationForHandle?.(params.terminal) ?? 0)
        : 0
      let rendererMountRequestedBeforePty = false
      const clientId = params.client?.id
      // Why: register before the pty wait so an unsubscribe, a same-slot replacement or a closed socket can end a pending stream.
      // Client-scoped keys also let a hidden watcher and a visible pane subscribe to one terminal.
      const registration = registerTerminalSubscription({
        runtime,
        subscriptionId: clientId ? `${params.terminal}:${clientId}` : params.terminal,
        connectionId,
        requestSignal: signal,
        emit
      })
      try {
        if (!leaf?.ptyId && params.client) {
          rendererMountRequestedBeforePty = runtime.requestRendererTerminalTabMount(params.terminal)
          const ptyId = await runtime
            .waitForLeafPtyId(params.terminal, 10_000, registration.signal)
            .catch(() => null)
          if (registration.released) {
            return
          }
          leaf = { ptyId }
        }
        if (!leaf?.ptyId) {
          const read = await runtime.readTerminal(params.terminal)
          if (registration.released) {
            return
          }
          emit({
            type: 'subscribed',
            streamId: null,
            lines: read.tail,
            truncated: isTerminalReadPayloadIncomplete(read)
          })
          return
        }

        const ptyId = leaf.ptyId
        registration.releaseOnPtyExit(ptyId)
        if (registration.released) {
          return
        }
        const missingHeadlessStateBeforeMobileFit =
          isMobile &&
          (rendererMountRequestedBeforePty || runtime.hasHeadlessTerminalState?.(ptyId) === false)
        const args: TerminalSubscriptionArgs = {
          params,
          runtime,
          registration,
          sendBinary,
          registerBinaryStreamHandler,
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
      } catch (error) {
        // Why: a released stream already sent `end`; an error frame after it would contradict it.
        if (registration.released) {
          return
        }
        registration.releaseSilently()
        throw error
      } finally {
        registration.release()
      }
    }
  })
]
