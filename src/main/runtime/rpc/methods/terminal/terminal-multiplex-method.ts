import { defineStreamingMethod, type RpcAnyMethod } from '../../core'
import { TerminalStreamOpcode } from '../../../../../shared/terminal-stream-protocol'
import { TERMINAL_MULTIPLEX_ACK_TOTAL_INITIAL_WINDOW_BYTES } from '../../../../../shared/terminal-multiplex-flow-control'
import { TerminalSourceRangeRegistry } from '../../terminal-source-range-registry'
import { TerminalMultiplex } from './stream-schemas'
import type { TerminalMultiplexConnectionBase } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'
import { installMultiplexFrameDelivery } from './terminal-multiplex-frame-delivery'
import { installMultiplexFlowControl } from './terminal-multiplex-flow-control'
import { installMultiplexCleanup } from './terminal-multiplex-cleanup'
import { installMultiplexSlotFrames } from './terminal-multiplex-slot-frames'
import { installMultiplexSubscribeFrame } from './terminal-multiplex-subscribe-frame'

export const TERMINAL_MULTIPLEX_METHODS: RpcAnyMethod[] = [
  defineStreamingMethod({
    name: 'terminal.multiplex',
    params: TerminalMultiplex,
    handler: async (
      _params,
      { runtime, connectionId, sendBinary, registerBinaryStreamHandler, signal },
      emit
    ) => {
      if (!sendBinary || !registerBinaryStreamHandler || !connectionId) {
        throw new Error('binary_terminal_stream_required')
      }
      let resolveMultiplex = (): void => {}
      const multiplexClosed = new Promise<void>((resolve) => {
        resolveMultiplex = resolve
      })
      // Installers only close over this per-connection state; none of it is module-global.
      const state: TerminalMultiplexConnectionBase = {
        runtime,
        connectionId,
        sendBinary,
        registerBinaryStreamHandler,
        signal,
        emit,
        closed: false,
        cursor: 0,
        streams: new Map<number, TerminalMultiplexStream>(),
        sourceRangeRegistry: new TerminalSourceRangeRegistry(),
        pendingPtyWaitControllers: new Map<number, Set<AbortController>>(),
        ackTotalInFlightBytes: 0,
        ackTotalWindowBytes: TERMINAL_MULTIPLEX_ACK_TOTAL_INITIAL_WINDOW_BYTES,
        ackFlushCursorStreamId: null,
        resolveMultiplex,
        multiplexClosed,
        unregisterControlHandler: () => {}
      }

      installMultiplexFrameDelivery(state)
      installMultiplexFlowControl(state)
      installMultiplexCleanup(state)
      installMultiplexSlotFrames(state)
      installMultiplexSubscribeFrame(state)

      state.unregisterControlHandler = registerBinaryStreamHandler(0, (frame) => {
        if (frame.opcode === TerminalStreamOpcode.Subscribe) {
          void state.handleSubscribeFrame(frame.payload)
        }
      })
      signal?.addEventListener('abort', state.cancelAllPendingPtyWaits, { once: true })
      runtime.registerSubscriptionCleanup(
        `terminal-multiplex:${connectionId}`,
        state.closeMultiplex,
        connectionId
      )
      emit({ type: 'ready' })
      await multiplexClosed
    }
  })
]
