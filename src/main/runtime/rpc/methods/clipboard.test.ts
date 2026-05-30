import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'

const { saveClipboardImageBufferAsTempFile } = vi.hoisted(() => ({
  saveClipboardImageBufferAsTempFile: vi.fn()
}))

vi.mock('../../../window/clipboard-image-temp-file', () => ({
  saveClipboardImageBufferAsTempFile
}))

import { CLIPBOARD_METHODS } from './clipboard'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('clipboard RPC methods', () => {
  beforeEach(() => {
    saveClipboardImageBufferAsTempFile.mockReset()
  })

  it('saves browser-provided clipboard image bytes on the runtime host', async () => {
    saveClipboardImageBufferAsTempFile.mockResolvedValue(
      'C:\\Users\\alice\\AppData\\Local\\Temp\\orca-paste-image.png'
    )
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIPBOARD_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('clipboard.saveImageAsTempFile', {
        contentBase64: Buffer.from('png-bytes').toString('base64'),
        connectionId: null
      })
    )

    expect(response).toMatchObject({
      ok: true,
      result: 'C:\\Users\\alice\\AppData\\Local\\Temp\\orca-paste-image.png'
    })
    expect(saveClipboardImageBufferAsTempFile).toHaveBeenCalledWith(Buffer.from('png-bytes'), {
      connectionId: null
    })
  })

  it('rejects non-base64 clipboard image payloads', async () => {
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIPBOARD_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('clipboard.saveImageAsTempFile', {
        contentBase64: 'not base64!'
      })
    )

    expect(response.ok).toBe(false)
    expect(saveClipboardImageBufferAsTempFile).not.toHaveBeenCalled()
  })
})
