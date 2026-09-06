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

  request(payload: Exclude<MobileWebTerminalRequest, { operation: 'subscribe' }>): Promise<null> {
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
