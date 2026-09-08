import { sendMobileTerminalQueryReply } from '../terminal/mobile-terminal-query-reply'
import { isTerminalSendRpcAccepted } from '../terminal/terminal-send-rpc-response'
import { TERMINAL_INPUT_SEND_OPTIONS } from '../terminal/terminal-send-request'
import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionTerminalOperations } from './host-session-terminal-operations'
import { subscribeMobileTerminalSafely } from './mobile-terminal-stream-subscribe'

export function nativeHostSessionTerminalOperations(
  client: RpcClient
): HostSessionTerminalOperations {
  const subscribedTerminals = new Set<string>()
  return {
    subscribe(args, onEvent, onError) {
      const unsubscribe = subscribeMobileTerminalSafely(
        client,
        {
          terminal: args.terminalId,
          ...(args.clientId ? { client: { id: args.clientId, type: 'mobile' as const } } : {}),
          viewport: args.viewport,
          capabilities: args.capabilities
        },
        (event) => onEvent(event as Parameters<typeof onEvent>[0]),
        onError
      )
      subscribedTerminals.add(args.terminalId)
      return () => {
        subscribedTerminals.delete(args.terminalId)
        unsubscribe()
      }
    },
    acknowledge() {},
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
    sendQueryReply(terminalId, bytes, clientId, hostSupportsQueryReply) {
      return sendMobileTerminalQueryReply({
        bytes,
        client,
        clientId,
        connected: true,
        handle: terminalId,
        hostSupportsQueryReplyInput: hostSupportsQueryReply,
        subscribedTerminals
      })
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
    clear(terminalId) {
      return client.sendRequest('terminal.clearBuffer', { terminal: terminalId }).then(
        (response) => response.ok,
        () => false
      )
    },
    rename(terminalId, title) {
      return client.sendRequest('terminal.rename', { terminal: terminalId, title }).then(
        (response) => response.ok,
        () => false
      )
    }
  }
}
