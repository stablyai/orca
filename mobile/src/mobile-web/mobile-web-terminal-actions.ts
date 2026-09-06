import type { MobileWebTerminalRequest } from '../../../src/shared/mobile-web/terminal-stream-contract'
import type { RpcClient } from '../transport/rpc-client'
import { mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import type { MobileWebTerminalStreamRecord } from './mobile-web-terminal-flow-control'

type MobileWebTerminalAction = Extract<
  MobileWebTerminalRequest,
  { operation: 'displayMode' | 'clear' | 'rename' }
>

export async function runMobileWebTerminalAction(args: {
  client: RpcClient
  clientId: string
  record: MobileWebTerminalStreamRecord
  request: MobileWebTerminalAction
}): Promise<void> {
  const { client, clientId, record, request } = args
  let response
  if (request.operation === 'displayMode') {
    response = await client.sendRequest('terminal.setDisplayMode', {
      terminal: record.terminal,
      mode: request.mode,
      client: { id: clientId, type: 'mobile' },
      ...(request.viewport && request.mode === 'auto' ? { viewport: request.viewport } : {})
    })
  } else if (request.operation === 'clear') {
    response = await client.sendRequest('terminal.clearBuffer', { terminal: record.terminal })
  } else {
    response = await client.sendRequest('terminal.rename', {
      terminal: record.terminal,
      title: request.title
    })
  }
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
}
