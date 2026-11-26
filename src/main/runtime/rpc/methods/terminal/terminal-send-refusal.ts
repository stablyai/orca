import type { RuntimeTerminalSend } from '../../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import type { TerminalRunFactsRegister } from '../../../terminal/lifecycle/terminal-run-facts'

export function refusedSend(
  handle: string,
  refusedReason?: RuntimeTerminalSend['refusedReason'],
  inputGeneration?: number
): { send: RuntimeTerminalSend } {
  return {
    send: {
      handle,
      accepted: false,
      bytesWritten: 0,
      ...(refusedReason ? { refusedReason } : {}),
      ...(inputGeneration === undefined ? {} : { inputGeneration })
    }
  }
}

/** A guard's refusal; an input-changed one names the generation a later resolution must exceed. */
export function guardRefusedSend(
  handle: string,
  refusedReason: NonNullable<RuntimeTerminalSend['refusedReason']>,
  runtime: { terminalRunFacts: Pick<TerminalRunFactsRegister, 'readInputGeneration'> },
  ptyId: string | null | undefined
): { send: RuntimeTerminalSend } {
  return refusedSend(
    handle,
    refusedReason,
    refusedReason === 'input-changed' && ptyId
      ? runtime.terminalRunFacts.readInputGeneration(ptyId)
      : undefined
  )
}
