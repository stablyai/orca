import { isTerminalSendRpcAccepted } from '../terminal/terminal-send-rpc-response'
import { TERMINAL_INPUT_SEND_OPTIONS } from '../terminal/terminal-send-request'
import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionTerminalOperations } from './host-session-terminal-operations'

export function nativeHostSessionTerminalOperations(
  client: RpcClient
): HostSessionTerminalOperations {
  return {
    async sendInput(terminalId, text, enter, clientId) {
      return client
        .sendRequest(
          'terminal.send',
          {
            terminal: terminalId,
            text,
            enter,
            ...(clientId ? { client: { id: clientId, type: 'mobile' as const } } : {})
          },
          TERMINAL_INPUT_SEND_OPTIONS
        )
        .then(isTerminalSendRpcAccepted, () => false)
    },
    setDisplayMode(terminalId, mode, viewport, clientId) {
      return client
        .sendRequest('terminal.setDisplayMode', {
          terminal: terminalId,
          mode,
          ...(clientId ? { client: { id: clientId, type: 'mobile' as const } } : {}),
          ...(viewport && mode === 'auto' ? { viewport } : {})
        })
        .then(
          (response) => response.ok,
          () => false
        )
    },
    async clear(terminalId) {
      // Rejection is deliberately not caught: the caller distinguishes a clear that never
      // reached the host from one the host refused, and only the former is a failure.
      const response = await client.sendRequest('terminal.clearBuffer', { terminal: terminalId })
      return response.ok
    },
    rename(terminalId, title) {
      return client.sendRequest('terminal.rename', { terminal: terminalId, title }).then(
        (response) => response.ok,
        () => false
      )
    }
  }
}
