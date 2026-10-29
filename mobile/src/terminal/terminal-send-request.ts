import type { SendRequestOptions } from '../transport/rpc-client'

type TerminalSendParams = {
  readonly terminal: string
  readonly text: string
  readonly enter: boolean
  readonly client?: { readonly id: string; readonly type: 'mobile' }
}

// Never park keystrokes during connect waits; they would replay stale input into the PTY after reconnect.
export const TERMINAL_INPUT_SEND_OPTIONS: SendRequestOptions = { failWhenDisconnected: true }

export function buildTerminalSendParams(args: {
  terminal: string
  text: string
  enter: boolean
  // Take the input floor so multi-phone contention follows the latest actor.
  deviceToken: string | null
}): TerminalSendParams {
  return {
    terminal: args.terminal,
    text: args.text,
    enter: args.enter,
    ...(args.deviceToken ? { client: { id: args.deviceToken, type: 'mobile' as const } } : {})
  }
}
