import { triggerError } from '../platform/haptics'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { terminalInputSend } from './mobile-terminal-operations'
import { buildTerminalSendParams, TERMINAL_INPUT_SEND_OPTIONS } from './terminal-send-request'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'
import { isTerminalLiveInputWithinByteLimit } from './terminal-live-input'
import { reportWorkerTerminalUserInput } from './worker-terminal-takeover-report'

export async function sendLiveTerminalInputBytes(args: {
  client: RpcClient | null
  connection: ConnectionState
  handle: string
  activeHandle: string | null
  activeSessionTabType: string | null
  deviceToken: string | null
  bytes: string
  showToast: (message: string, duration?: number) => void
}): Promise<boolean> {
  const text = normalizeTerminalTextInput(args.bytes)
  if (text.length === 0) {
    return false
  }
  if (!isTerminalLiveInputWithinByteLimit(text)) {
    triggerError()
    args.showToast('Input too large (max 256 KiB)', 1500)
    return false
  }
  const { client, connection, handle, activeHandle, activeSessionTabType, deviceToken } = args
  if (
    !client ||
    connection !== 'connected' ||
    handle !== activeHandle ||
    activeSessionTabType !== 'terminal'
  ) {
    return false
  }
  return terminalInputSend
    .request(
      client,
      buildTerminalSendParams({ terminal: handle, text, enter: false, deviceToken }),
      TERMINAL_INPUT_SEND_OPTIONS
    )
    .then(
      (response) => {
        const accepted = terminalInputSend.interpret(response) === true
        if (accepted) {
          reportWorkerTerminalUserInput(client, handle)
        }
        return accepted
      },
      () => false
    )
}
