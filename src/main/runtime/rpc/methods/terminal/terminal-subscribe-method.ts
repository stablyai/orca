import { defineStreamingMethod } from '../../core'
import { TerminalSubscribe } from '../../../../../shared/rpc-contract/terminal-stream-params'
import { isTerminalReadPayloadIncomplete } from './terminal-stream-replay'
import { runTerminalBinarySubscription } from './terminal-subscribe-binary'
import {
  runTerminalJsonSubscription,
  runTerminalLeaseSubscription
} from './terminal-subscribe-json-and-lease'
import type { TerminalSubscriptionArgs } from './terminal-subscribe-types'
import { registerTerminalSubscription } from './terminal-subscription-registration'

export const TERMINAL_SUBSCRIBE_METHODS = [
  defineStreamingMethod({
    name: 'terminal.subscribe',
    permission: 'workspace',
    params: TerminalSubscribe,
    handler: async (
      params,
      { runtime, connectionId, requestId, sendBinary, registerBinaryStreamHandler, signal },
      emit
    ) => {
      const isMobile = params.client?.type === 'mobile'
      const useBinaryStream = params.capabilities?.terminalBinaryStream === 1 && Boolean(sendBinary)
      // Validate before registration so impossible requests cannot evict a live stream.
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
      // Register before PTY wait so unsubscribe, replacement and socket close cancel it; client-scoped keys allow sibling watchers.
      const registration = registerTerminalSubscription({
        runtime,
        subscriptionId: clientId ? `${params.terminal}:${clientId}` : params.terminal,
        connectionId,
        requestId,
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
        if (isMobile && leaf?.ptyId) {
          // Opening a terminal counts as workspace use for cleanup.
          runtime.sidebarFacts?.terminalUse.noteTerminalUse(leaf.ptyId, Date.now())
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
        // Release already sent end; a later error would contradict it.
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
