import type { RpcClient } from '../transport/rpc-client'
import { isTerminalSendRpcAccepted } from './terminal-send-rpc-response'
import { buildTerminalSendParams, TERMINAL_INPUT_SEND_OPTIONS } from './terminal-send-request'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'

export type LiveTerminalInputRpc = Pick<RpcClient, 'sendRequest'> &
  Partial<Pick<RpcClient, 'sendTerminalInput'>>

export async function sendLiveTerminalInputBytes(args: {
  rpc: LiveTerminalInputRpc | null
  handle: string
  bytes: string
  connected: boolean
  activeHandle: string | null
  activeSessionTabType: string | null
  deviceToken: string | null
}): Promise<boolean> {
  const text = normalizeTerminalTextInput(args.bytes)
  if (text.length === 0) {
    return false
  }
  if (
    !args.rpc ||
    !args.connected ||
    args.handle !== args.activeHandle ||
    args.activeSessionTabType !== 'terminal'
  ) {
    return false
  }
  // Why: Input frames return after the socket write; waiting for terminal.send
  // would reintroduce one RTT per mirror delta on every transport.
  const streamResult = args.rpc.sendTerminalInput?.(args.handle, text)
  if (streamResult === 'sent') {
    return true
  }
  if (streamResult === 'failed') {
    return false
  }
  return args.rpc
    .sendRequest(
      'terminal.send',
      buildTerminalSendParams({
        terminal: args.handle,
        text,
        enter: false,
        deviceToken: args.deviceToken
      }),
      TERMINAL_INPUT_SEND_OPTIONS
    )
    .then(isTerminalSendRpcAccepted, () => false)
}
