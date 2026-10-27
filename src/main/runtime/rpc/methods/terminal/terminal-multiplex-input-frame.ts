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
  // Mark policy-dropped locked/unclaimed input applied so replay cannot run it later; empty sequences fill abandoned slots.
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
      // Ack only after provider handoff because clients delete their replay copy.
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
  // Ack duplicates too because prior ack may be lost; refusals request in-stream resend, never remount.
  void inputSequenceLedger
    .admit(stream.ptyId, inputSessionId, frame.seq, deliver)
    .then((admission) => state.sendInputAck(stream, admission.appliedSeq, admission.kind))
}
