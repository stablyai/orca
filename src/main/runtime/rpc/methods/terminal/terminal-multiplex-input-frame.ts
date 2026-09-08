import {
  TerminalStreamOpcode,
  decodeTerminalStreamText,
  type TerminalStreamFrame
} from '../../../../../shared/terminal-stream-protocol'
import { isTerminalInputLockedForClient, sendTerminalStreamInput } from './terminal-input-delivery'
import { isAcceptableTerminalQueryReplyFrame } from './terminal-query-reply-guard'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

export function isMultiplexInputFrame(
  stream: TerminalMultiplexStream,
  frame: TerminalStreamFrame
): boolean {
  return (
    frame.opcode === TerminalStreamOpcode.Input ||
    (frame.opcode === TerminalStreamOpcode.QueryReply && stream.supportsQueryReply)
  )
}

export function handleMultiplexInputFrame(
  state: TerminalMultiplexConnection,
  stream: TerminalMultiplexStream,
  frame: TerminalStreamFrame
): void {
  const { runtime } = state
  const text = decodeTerminalStreamText(frame.payload)
  if (!text) {
    return
  }
  if (isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)) {
    return
  }
  // Mobile already has the higher-priority floor, so a rejected desktop claim must not suppress later phone input.
  const inputClaimTail = stream.isMobile ? Promise.resolve(true) : stream.desktopClaimTail
  const isQueryReply = frame.opcode === TerminalStreamOpcode.QueryReply
  void inputClaimTail.then(async (claimed) => {
    if (!claimed || isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)) {
      return
    }
    // Why: opcode 18 skips the mobile input floor, so it needs every guard terminal.send applies; drop otherwise.
    if (
      isQueryReply &&
      !isAcceptableTerminalQueryReplyFrame({
        runtime,
        ptyId: stream.ptyId,
        text,
        client: stream.client,
        connectionClientId: state.connectionClientId
      })
    ) {
      return
    }
    const outcome = await sendTerminalStreamInput(runtime, {
      terminal: stream.terminal,
      text,
      client: stream.client,
      isMobile: stream.isMobile,
      inputKind: isQueryReply ? 'query-reply' : 'input'
    })
    state.notifyStreamWriteUnavailable(stream, outcome)
  })
}
