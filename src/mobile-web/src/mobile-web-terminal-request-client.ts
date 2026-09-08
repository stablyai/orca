import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { mobileWebHostTerminalActions } from './mobile-web-host-terminal-actions'
import { MobileWebHapticSelectionResultSchema } from '../../shared/mobile-web/bridge-operation-contract'
import {
  MobileWebTerminalDeviceInputResultSchema,
  MobileWebTerminalRequestSchema,
  type MobileWebTerminalDeviceInputResult,
  type MobileWebTerminalRequest
} from '../../shared/mobile-web/terminal-stream-contract'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

// One-shot terminal operations; the stream itself lives on the subscription client.
export class MobileWebTerminalRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  // Resolved rather than plain: callers await it, and there is nothing left to ask the host.
  prepareActions(workspaceId: string, tabId: string, signal: AbortSignal) {
    return Promise.resolve(mobileWebHostTerminalActions(this.requests, workspaceId, tabId, signal))
  }

  request(payload: Exclude<MobileWebTerminalRequest, { operation: 'subscribe' }>): Promise<null> {
    if (
      payload.operation === 'displayMode' ||
      payload.operation === 'clear' ||
      payload.operation === 'rename'
    ) {
      return Promise.reject(new MobileWebBridgeClientError('unsupported_capability', false))
    }
    return this.requests.request(
      'terminal',
      payload.operation,
      payload,
      MobileWebTerminalRequestSchema,
      MobileWebHapticSelectionResultSchema
    )
  }

  deviceInput(
    payload: Extract<MobileWebTerminalRequest, { operation: 'clipboardPaste' | 'attachImage' }>
  ): Promise<MobileWebTerminalDeviceInputResult> {
    return this.requests.request(
      'terminal',
      payload.operation,
      payload,
      MobileWebTerminalRequestSchema,
      MobileWebTerminalDeviceInputResultSchema
    )
  }
}

export function mobileWebTerminalClientBindings(requests: MobileWebOneShotRequestClient) {
  const client = new MobileWebTerminalRequestClient(requests)
  return {
    prepareTerminalActions: client.prepareActions.bind(client),
    terminalRequest: client.request.bind(client),
    terminalDeviceInputRequest: client.deviceInput.bind(client)
  }
}
