import type { TerminalModes } from '../terminal/terminal-webview-contract'
import type { RpcClient } from '../transport/rpc-client'

export function defaultMobileTerminalPastePayload(_args: {
  client: RpcClient
  connectionId: () => Promise<string | null>
  modes: TerminalModes | undefined
}): Promise<never> {
  return Promise.reject(new Error('Native terminal paste is unavailable'))
}
