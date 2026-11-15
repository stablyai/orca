import type { RuntimeTerminalSend } from '../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import type { WriteSettlement } from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import type { TerminalRunFactsRegister } from '../lifecycle/terminal-run-facts'
import type { RuntimeTerminalWriteOptions, RuntimeTerminalWriter } from './runtime-terminal-writer'

/** Writes one send to its PTY and answers with its receipt. For a paste whose Enter the client
 *  sends itself, the receipt names the wait and the input generation that Enter must find unchanged. */
export async function writeTerminalSendForReceipt(
  host: {
    writer: Pick<RuntimeTerminalWriter, 'clientSubmitDelay'>
    runFacts: Pick<TerminalRunFactsRegister, 'trackOwnInput' | 'beginClientPaste'>
    writeAction: (options: RuntimeTerminalWriteOptions) => Promise<WriteSettlement | undefined>
  },
  send: {
    handle: string
    ptyId: string
    action: { text?: string; enter?: boolean; interrupt?: boolean }
    payload: string
    options: RuntimeTerminalWriteOptions
  }
): Promise<RuntimeTerminalSend> {
  const { handle, ptyId, action, payload, options } = send
  const clientText =
    options.clientSubmit && action.text && !action.enter && !action.interrupt
      ? action.text
      : undefined
  const finishPaste = clientText ? host.runFacts.beginClientPaste(ptyId) : undefined
  let submitDelayMs: number | undefined
  let writeMayHaveStarted = false
  try {
    submitDelayMs = clientText ? await host.writer.clientSubmitDelay(ptyId, clientText) : undefined
    const ownInput = clientText ? host.runFacts.trackOwnInput(ptyId) : undefined
    writeMayHaveStarted = true
    const writeSettlement = await host.writeAction(ownInput ? { ...options, ownInput } : options)
    if (writeSettlement?.outcome === 'refused') {
      writeMayHaveStarted = false
    }
    const accepted = !writeSettlement || writeSettlement.outcome === 'accepted'
    const inputGeneration = ownInput?.generation()
    return {
      handle,
      accepted,
      ...(writeSettlement ? { writeSettlement } : {}),
      bytesWritten: accepted ? Buffer.byteLength(payload, 'utf8') : 0,
      ...(accepted && submitDelayMs !== undefined
        ? { submitDelayMs, ...(inputGeneration === undefined ? {} : { inputGeneration }) }
        : {})
    }
  } finally {
    // Partial writes and lost acknowledgments still need ingestion protection.
    finishPaste?.(writeMayHaveStarted ? submitDelayMs : undefined)
  }
}
