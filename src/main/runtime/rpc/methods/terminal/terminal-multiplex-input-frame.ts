import {
  decodeTerminalStreamText,
  type TerminalStreamFrame
} from '../../../../../shared/terminal-stream-protocol'
import { isTerminalInputLockedForClient, sendTerminalStreamInput } from './terminal-input-delivery'
import type {
  TerminalInputSequenceLedger,
  TerminalInputWriteOutcome
} from './terminal-input-sequence-ledger'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

export function handleMultiplexInputFrame(
  state: TerminalMultiplexConnection,
  inputSequenceLedger: TerminalInputSequenceLedger,
  stream: TerminalMultiplexStream,
  frame: TerminalStreamFrame
): void {
  const { runtime } = state
  const text = decodeTerminalStreamText(frame.payload)
  // Mobile already has the higher-priority floor, so a rejected desktop claim must not suppress later phone input.
  const inputClaimTail = stream.isMobile ? Promise.resolve(true) : stream.desktopClaimTail
  const inputSessionId = frame.seq > 0 ? stream.inputSessionId : null
  const sequenced = inputSessionId !== null
  // Why 'applied' for locked or unclaimed input: it is dropped by policy, and a replay must not run it later.
  // Empty sequenced input is how a client fills the slot of input it gave up, so later input can follow.
  const deliver = async (): Promise<TerminalInputWriteOutcome> => {
    if (!text || isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)) {
      return 'applied'
    }
    const claimed = await inputClaimTail
    if (!claimed || isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)) {
      return 'applied'
    }
    const outcome = await sendTerminalStreamInput(runtime, {
      terminal: stream.terminal,
      text,
      client: stream.client,
      isMobile: stream.isMobile,
      // Why: an ack drops the client's replay copy, so it must wait for the provider's handoff.
      requireWriteSettlement: sequenced
    })
    if (!sequenced) {
      state.notifyStreamWriteUnavailable(stream, outcome)
    }
    return outcome === 'delivered'
      ? 'applied'
      : outcome === 'rejected'
        ? 'refused'
        : 'delivery-unknown'
  }
  if (inputSessionId === null) {
    void deliver()
    return
  }
  // Why every frame is answered, duplicates too: the client resends until acked, and an earlier
  // ack may have died with its connection. A refusal asks this live stream to resend, never remounts.
  void inputSequenceLedger
    .admit(stream.ptyId, inputSessionId, frame.seq, deliver)
    .then((admission) => state.sendInputAck(stream, admission.appliedSeq, admission.kind))
}
