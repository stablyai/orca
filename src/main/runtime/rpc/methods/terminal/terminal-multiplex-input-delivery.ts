import {
  decodeTerminalStreamText,
  type TerminalStreamFrame
} from '../../../../../shared/terminal-stream-protocol'
import { isTerminalInputLockedForClient, sendTerminalStreamInput } from './terminal-input-delivery'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

export function receiveMultiplexInput(
  state: TerminalMultiplexConnection,
  stream: TerminalMultiplexStream,
  frame: TerminalStreamFrame
): void {
  const { runtime, streams } = state
  const text = decodeTerminalStreamText(frame.payload)
  if (!text) {
    return
  }
  const acknowledge = stream.acknowledgeInput && Number.isSafeInteger(frame.seq) && frame.seq > 0
  const publishReceipt = (outcome: 'accepted' | 'refused' | 'unverifiable'): void => {
    if (acknowledge && !state.closed && streams.get(stream.streamId) === stream) {
      state.emit({ type: 'input-ack', streamId: stream.streamId, seq: frame.seq, outcome })
    }
  }
  if (isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)) {
    publishReceipt('refused')
    return
  }
  // Mobile already has the higher-priority floor, so a rejected desktop claim must not suppress later phone input.
  const inputClaimTail = stream.isMobile ? Promise.resolve(true) : stream.desktopClaimTail
  void inputClaimTail.then(async (claimed) => {
    if (state.closed || streams.get(stream.streamId) !== stream) {
      return
    }
    if (!claimed || isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)) {
      publishReceipt('refused')
      return
    }
    const outcome = await sendTerminalStreamInput(runtime, {
      terminal: stream.terminal,
      text,
      client: stream.client,
      isMobile: stream.isMobile,
      ...(acknowledge ? { requireWriteSettlement: true as const } : {})
    })
    publishReceipt(
      outcome === 'delivered' ? 'accepted' : outcome === 'rejected' ? 'refused' : 'unverifiable'
    )
    state.notifyStreamWriteUnavailable(stream, outcome)
  })
}
