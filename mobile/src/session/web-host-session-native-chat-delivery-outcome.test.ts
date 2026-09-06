import { describe, expect, it, vi } from 'vitest'
import {
  MobileWebBridgeClientError,
  type MobileWebBridgeClient
} from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostSessionNativeChatTarget } from './host-session-native-chat-operations'
import { webHostSessionNativeChatOperations } from './web-host-session-native-chat-operations'

const TARGET: HostSessionNativeChatTarget = {
  workspaceId: 'workspace',
  agent: 'codex',
  sessionId: 'session',
  transcriptPath: null,
  terminalId: null,
  clientId: null
}

describe('hosted native-chat delivery outcomes', () => {
  it.each(['timeout', 'cancelled', 'invalid_message', 'internal'] as const)(
    'keeps %s bridge failures delivery-ambiguous',
    async (code) => {
      const operations = webHostSessionNativeChatOperations(
        clientWithMutationError(new MobileWebBridgeClientError(code, true))
      )

      await expect(operations.sendMessage(TARGET, 'hello')).resolves.toBe('unknown')
      await expect(operations.respond(TARGET, '1', false)).resolves.toBe('unknown')
      await expect(operations.stop(TARGET)).resolves.toBe('unknown')
    }
  )

  it('keeps a proven pre-dispatch bridge failure rejected', async () => {
    const operations = webHostSessionNativeChatOperations(
      clientWithMutationError(new MobileWebBridgeClientError('not_connected', true))
    )

    await expect(operations.sendMessage(TARGET, 'hello')).resolves.toBe('rejected')
  })

  it('passes through the broker delivery outcome', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ outcome: 'unknown' })
    const operations = webHostSessionNativeChatOperations({
      nativeChat: { sendMessage }
    } as unknown as MobileWebBridgeClient)

    await expect(operations.sendMessage(TARGET, 'hello')).resolves.toBe('unknown')
  })
})

function clientWithMutationError(error: MobileWebBridgeClientError): MobileWebBridgeClient {
  return {
    nativeChat: {
      sendMessage: vi.fn().mockRejectedValue(error),
      respond: vi.fn().mockRejectedValue(error),
      stop: vi.fn().mockRejectedValue(error)
    }
  } as unknown as MobileWebBridgeClient
}
