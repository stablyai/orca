import { TerminalStreamOpcode } from '../../../../../shared/terminal-stream-protocol'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

/** Tells a negotiated client that this pause discarded output, so its reveal must restore. */
export function notePausedOutputDropped(
  state: Pick<TerminalMultiplexConnection, 'sendFrame'>,
  stream: TerminalMultiplexStream
): void {
  if (!stream.supportsOutputPauseDropNotice || stream.pausedOutputDropNoticeSent) {
    return
  }
  // Why mark before send: a failed send means the link is going down, and resubscribe repaints anyway.
  stream.pausedOutputDropNoticeSent = true
  state.sendFrame(stream.streamId, TerminalStreamOpcode.PausedOutputDropped)
}
