import { reportWorkerTerminalUserInput } from './worker-terminal-takeover-report'
import { getTerminalLiveAccessoryRawSendTarget } from './terminal-live-accessory-raw-send-target'
import { buildTerminalSendParams, TERMINAL_INPUT_SEND_OPTIONS } from './terminal-send-request'
import { terminalInputSend } from './mobile-terminal-operations'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

type TerminalLiveAccessoryRawSendArgs = {
  readonly client: RpcClient | null
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
  return terminalInputSend
    .request(
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
        const accepted = terminalInputSend.interpret(reply) === true
        if (accepted) {
          reportWorkerTerminalUserInput(args.client!, rawSendTarget)
        }
        return accepted
      },
      () => false
    )
}
