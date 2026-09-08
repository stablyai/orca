import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebSpeechAuthority } from './mobile-web-speech-authority'
import { executeMobileWebSpeechOperation } from './mobile-web-speech-operations'

describe('executeMobileWebSpeechOperation', () => {
  it.each(['setup', 'configure', 'downloadModel', 'deleteModel'])(
    'retires the host-owned %s translator',
    async (operation) => {
      const harness = createHarness()
      await expect(harness.execute(operation, {})).rejects.toMatchObject({
        code: 'unsupported_capability'
      })
      expect(harness.sendRequest).not.toHaveBeenCalled()
    }
  )
})

function createHarness() {
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const client = { sendRequest } as unknown as RpcClient
  const authority = {
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn()
  } as unknown as MobileWebSpeechAuthority
  return {
    sendRequest,
    authority,
    execute: (operation: string, payload: unknown) =>
      executeMobileWebSpeechOperation({
        operation,
        payload,
        client,
        authority
      })
  }
}
