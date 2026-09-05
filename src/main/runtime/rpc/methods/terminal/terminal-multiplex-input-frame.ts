import { decodeTerminalStreamText } from '../../../../../shared/terminal-stream-protocol'
import { waitForPromiseWithSignal } from '../../../../../shared/abort-signal-reason'
import { runTerminalInputInArrivalOrder } from '../../../terminal-input-arrival'
import {
  isTerminalInputLockedForClient,
  isTerminalStreamInputRejection,
  sendTerminalStreamInput
} from './terminal-input-delivery'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

export function handleMultiplexInputFrame(
  state: TerminalMultiplexConnection,
  stream: TerminalMultiplexStream,
  payload: Uint8Array
): void {
  const { runtime } = state
  const text = decodeTerminalStreamText(payload)
  if (!text || isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)) {
    return
  }
  // Mobile input must not inherit a refused desktop viewport claim.
  const inputClaimTail = stream.isMobile ? Promise.resolve(true) : stream.desktopClaimTail
  const signal = stream.exitWaiterAbort.signal
  void runTerminalInputInArrivalOrder(
    runtime,
    stream.terminal,
    text.length,
    signal,
    async () => {
      const claimed = await waitForPromiseWithSignal(inputClaimTail, signal)
      if (!claimed || isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)) {
        return
      }
      const outcome = await sendTerminalStreamInput(runtime, {
        terminal: stream.terminal,
        text,
        client: stream.client,
        isMobile: stream.isMobile
      })
      state.notifyStreamWriteUnavailable(stream, outcome)
    },
    stream.inputTarget
  ).catch((error: unknown) => {
    state.notifyStreamWriteUnavailable(
      stream,
      isTerminalStreamInputRejection(error) ? 'rejected' : 'failed'
    )
  })
}
