import { getTerminalLiveAccessoryRawSendTarget } from './terminal-live-accessory-raw-send-target'
import { buildTerminalSendParams, TERMINAL_INPUT_SEND_OPTIONS } from './terminal-send-request'
import { terminalInputSend } from './mobile-terminal-operations'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import type { ConnectionState } from '../transport/types'

type TerminalLiveAccessoryRawSendArgs = {
  readonly sendTerminalUserInput: typeof terminalInputSend.request
  readonly client: RpcOperationSender | null
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
  // IME flush can outlive terminal selection; recheck the target afterward.
  const rawSendTarget = getTerminalLiveAccessoryRawSendTarget({
    targetHandle: args.targetHandle,
    activeHandle: args.activeHandle,
    activeSessionTabType: args.activeSessionTabType
  })
  if (!args.client || !rawSendTarget || args.connState !== 'connected') {
    return false
  }
  return args
    .sendTerminalUserInput(
      args.client,
      buildTerminalSendParams({
        terminal: rawSendTarget,
        text: args.bytes,
        enter: false,
        deviceToken: args.deviceToken
      }),
      TERMINAL_INPUT_SEND_OPTIONS
    )
    .then(
      (reply) => {
        return terminalInputSend.interpret(reply) === true
      },
      () => false
    )
}
