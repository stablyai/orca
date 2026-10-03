import { decodeTerminalStreamText } from '../../../../../shared/terminal-stream-protocol'
import { isTerminalInputLockedForClient, sendTerminalStreamInput } from './terminal-input-delivery'
import { getTerminalMultiplexProgress } from './terminal-multiplex-progress'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

export function handleTerminalMultiplexInput(
  state: TerminalMultiplexConnection,
  stream: TerminalMultiplexStream,
  payload: Uint8Array<ArrayBufferLike>
): void {
  const entry = getTerminalMultiplexProgress(state, stream)
  const { progress } = entry
  progress.count('inputReceived')
  progress.count('inputBytes', payload.byteLength)
  const text = decodeTerminalStreamText(payload)
  if (!text) {
    return
  }
  if (isTerminalInputLockedForClient(state.runtime, stream.ptyId, stream.client)) {
    progress.count('inputMobileLocked')
    progress.report('input_refused')
    return
  }
  const inputClaimTail = stream.isMobile ? Promise.resolve(true) : stream.desktopClaimTail
  entry.inputAwaitingClaim += 1
  void inputClaimTail.then(async (claimed) => {
    entry.inputAwaitingClaim -= 1
    if (!claimed) {
      progress.count('inputClaimRefused')
      progress.report('input_refused')
      return
    }
    if (isTerminalInputLockedForClient(state.runtime, stream.ptyId, stream.client)) {
      progress.count('inputMobileLocked')
      progress.report('input_refused')
      return
    }
    entry.inputDispatchPending += 1
    const outcome = await sendTerminalStreamInput(state.runtime, {
      terminal: stream.terminal,
      text,
      client: stream.client,
      isMobile: stream.isMobile
    })
    entry.inputDispatchPending -= 1
    if (outcome === 'delivered') {
      progress.count('inputDelivered')
    } else {
      progress.count(outcome === 'rejected' ? 'inputRejected' : 'inputFailed')
      progress.report('input_refused')
    }
    state.notifyStreamWriteUnavailable(stream, outcome)
  })
}
