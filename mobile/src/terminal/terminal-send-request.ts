import type { SendRequestOptions } from '../transport/rpc-client'

type TerminalSendParams = {
  readonly terminal: string
  readonly text: string
  readonly enter: boolean
  readonly client?: { readonly id: string; readonly type: 'mobile' }
}

// Why: keystroke sends must never park in the connect wait — parked sends replay into the PTY after reconnect (#6713).
export const TERMINAL_INPUT_SEND_OPTIONS: SendRequestOptions = { failWhenDisconnected: true }

export function buildTerminalSendParams(args: {
  terminal: string
  text: string
  enter: boolean
  // Why: presence-lock take-floor; marks this phone active so multi-mobile contention resolves to the last actor.
  deviceToken: string | null
}): TerminalSendParams {
  return {
    terminal: args.terminal,
    text: args.text,
    enter: args.enter,
    ...(args.deviceToken ? { client: { id: args.deviceToken, type: 'mobile' as const } } : {})
  }
}
