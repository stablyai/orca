import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileWebSpeechAuthority } from './mobile-web-speech-authority'
import { executeMobileWebSpeechOperation } from './mobile-web-speech-operations'

describe('executeMobileWebSpeechOperation', () => {
  it('parses bounded setup metadata', async () => {
    const harness = createHarness()
    harness.sendRequest.mockResolvedValue(success(setup()))

    await expect(harness.execute('setup', {})).resolves.toEqual(setup())
    expect(harness.sendRequest).toHaveBeenCalledWith('speech.models.list', null)
  })

  it('rejects a payload the operation contract does not accept', async () => {
    const harness = createHarness()

    await expect(harness.execute('configure', { dictationMode: 'shout' })).rejects.toBeTruthy()
    expect(harness.sendRequest).not.toHaveBeenCalled()
  })

  it('returns only parsed setup state after deleting a model', async () => {
    const harness = createHarness()
    harness.sendRequest.mockResolvedValue(success(setup()))

    await expect(harness.execute('deleteModel', { modelId: 'model-1' })).resolves.toEqual(setup())
    expect(harness.sendRequest).toHaveBeenCalledWith('speech.models.delete', {
      modelId: 'model-1'
    })
  })
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

function setup() {
  return {
    enabled: true,
    selectedModelId: 'model-1',
    dictationMode: 'toggle' as const,
    models: [
      {
        id: 'model-1',
        label: 'Model One',
        provider: 'local' as const,
        sizeBytes: 1024,
        recommended: true,
        status: 'ready' as const,
        progress: null
      }
    ]
  }
}

function success(result: unknown): RpcResponse {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'runtime' } }
}
