import type { RuntimeTerminalSend } from '../../../../shared/runtime-terminal-send-contract'
import type { WriteSettlement } from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import type { TerminalRunFactsRegister } from '../lifecycle/terminal-run-facts'
import type { RuntimeTerminalWriteOptions, RuntimeTerminalWriter } from './runtime-terminal-writer'

/** Writes one send to its PTY and answers with its receipt. For a paste whose Enter the client
 *  sends itself, the receipt names the wait and the input generation that Enter must find unchanged. */
export async function writeTerminalSendForReceipt(
  host: {
    writer: Pick<RuntimeTerminalWriter, 'clientSubmitDelay'>
    runFacts: Pick<TerminalRunFactsRegister, 'trackOwnInput' | 'recordClientPaste'>
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
  const clientSubmit =
    options.clientSubmit && action.text && !action.enter && !action.interrupt
      ? {
          submitDelayMs: await host.writer.clientSubmitDelay(ptyId, action.text),
          ownInput: host.runFacts.trackOwnInput(ptyId)
        }
      : undefined
  const writeSettlement = await host.writeAction(
    clientSubmit ? { ...options, ownInput: clientSubmit.ownInput } : options
  )
  const accepted = !writeSettlement || writeSettlement.outcome === 'accepted'
  const inputGeneration = clientSubmit?.ownInput.generation()
  if (accepted && clientSubmit) {
    host.runFacts.recordClientPaste(ptyId, clientSubmit.submitDelayMs)
  }
  return {
    handle,
    accepted,
    ...(writeSettlement ? { writeSettlement } : {}),
    bytesWritten: accepted ? Buffer.byteLength(payload, 'utf8') : 0,
    ...(accepted && clientSubmit
      ? {
          submitDelayMs: clientSubmit.submitDelayMs,
          ...(inputGeneration === undefined ? {} : { inputGeneration })
        }
      : {})
  }
}
