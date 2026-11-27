import {
  decodeTerminalStreamText,
  type TerminalStreamFrame
} from '../../../../../shared/terminal/stream/terminal-stream-protocol'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { isTerminalInputLockedForClient, sendTerminalStreamInput } from './terminal-input-delivery'
import type {
  TerminalInputSequenceLedger,
  TerminalInputWriteOutcome
} from './terminal-input-sequence-ledger'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

function isInputLocked(runtime: OrcaRuntimeService, stream: TerminalMultiplexStream): boolean {
  return isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)
}

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
  const arrivedAt = performance.now()
  // Mark policy-dropped locked/unclaimed input applied so replay cannot run it later; empty sequences fill abandoned slots.
  const deliver = async (): Promise<TerminalInputWriteOutcome> => {
    if (!text || isInputLocked(runtime, stream)) {
      return 'applied'
    }
    const claimed = await inputClaimTail
    if (!claimed || isInputLocked(runtime, stream)) {
      return 'applied'
    }
    const outcome = await sendTerminalStreamInput(runtime, {
      terminal: stream.terminal,
      text,
      client: stream.client,
      isMobile: stream.isMobile,
      arrivedAt,
      // Ack only after provider handoff because clients delete their replay copy.
      requireWriteSettlement: sequenced
    })
    if (!sequenced && outcome !== 'paused') {
      state.notifyStreamWriteUnavailable(stream, outcome)
    }
    return outcome === 'delivered' || outcome === 'paused'
      ? 'applied'
      : outcome === 'rejected'
        ? 'refused'
        : 'delivery-unknown'
  }
  if (inputSessionId === null) {
    if (!text || isInputLocked(runtime, stream)) {
      return
    }
    stream.unsequencedInputTail = stream.unsequencedInputTail.then(deliver).catch(() => undefined)
    return
  }
  // Ack duplicates too because prior ack may be lost; refusals request in-stream resend, never remount.
  void inputSequenceLedger
    .admit(stream.ptyId, inputSessionId, frame.seq, deliver)
    .then((admission) => state.sendInputAck(stream, admission.appliedSeq, admission.kind))
}
