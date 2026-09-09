import { getTerminalLiveAccessoryRawSendTarget } from './terminal-live-accessory-raw-send-target'
import { isTerminalSendRpcAccepted } from './terminal-send-rpc-response'
import { buildTerminalSendParams, TERMINAL_INPUT_SEND_OPTIONS } from './terminal-send-request'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

type TerminalLiveAccessoryRawSendArgs = {
  readonly client: Pick<RpcClient, 'sendRequest'> | null
  readonly targetHandle: string
  readonly activeHandle: string | null
  readonly activeSessionTabType: string | null
  readonly connState: ConnectionState
  readonly bytes: string
  readonly deviceToken: string | null
}

export async function sendTerminalLiveAccessoryRawBytes(
  args: TerminalLiveAccessoryRawSendArgs
): Promise<boolean> {
  // Why: async IME flushing can outlive the original terminal selection.
  const rawSendTarget = getTerminalLiveAccessoryRawSendTarget({
    targetHandle: args.targetHandle,
    activeHandle: args.activeHandle,
    activeSessionTabType: args.activeSessionTabType
  })
  if (!args.client || !rawSendTarget || args.connState !== 'connected') {
    return false
  }
  return args.client
    .sendRequest(
      'terminal.send',
      buildTerminalSendParams({
        terminal: rawSendTarget,
        text: args.bytes,
        enter: false,
        deviceToken: args.deviceToken
      }),
      TERMINAL_INPUT_SEND_OPTIONS
    )
    .then(isTerminalSendRpcAccepted, () => false)
}
