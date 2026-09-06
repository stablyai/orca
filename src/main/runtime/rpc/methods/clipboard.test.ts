import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest, RpcResponse } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  CLIPBOARD_IMAGE_MAX_BASE64_CHARS,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR
} from '../../../../shared/clipboard-image'

const { saveClipboardImageBufferAsTempFile } = vi.hoisted(() => ({
  saveClipboardImageBufferAsTempFile: vi.fn()
}))

vi.mock('../../../window/clipboard-image-temp-file', () => ({
  saveClipboardImageBufferAsTempFile
}))

import {
  CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS,
  CLIPBOARD_IMAGE_UPLOAD_MAX_CONCURRENT,
  CLIPBOARD_METHODS,
  resetClipboardImageUploadsForTest
} from './clipboard'
import {
  hasMobileClipboardImagePath,
  resetMobileClipboardImageProvenanceForTest
} from '../mobile-clipboard-image-provenance'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeDispatcher(): RpcDispatcher {
  const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: CLIPBOARD_METHODS })
}

async function callMobile(
  dispatcher: RpcDispatcher,
  method: string,
  params: unknown,
  clientId = 'device-a'
): Promise<RpcResponse> {
  const replies: RpcResponse[] = []
  await dispatcher.dispatchStreaming(
    makeRequest(method, params),
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    { clientKind: 'mobile', clientId }
  )
  const response = replies[0]
  if (!response) {
    throw new Error(`no reply for ${method}`)
  }
  return response
}

describe('clipboard RPC methods', () => {
  beforeEach(() => {
    saveClipboardImageBufferAsTempFile.mockReset()
    resetClipboardImageUploadsForTest()
    resetMobileClipboardImageProvenanceForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetClipboardImageUploadsForTest()
    resetMobileClipboardImageProvenanceForTest()
  })

  it('saves browser-provided clipboard image bytes on the runtime host', async () => {
    saveClipboardImageBufferAsTempFile.mockResolvedValue(
      'C:\\Users\\alice\\AppData\\Local\\Temp\\orca-paste-image.png'
    )
    const dispatcher = makeDispatcher()

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

  it('records a successful direct mobile upload for only the authenticated client', async () => {
    const path = '/tmp/orca-paste-image.png'
    saveClipboardImageBufferAsTempFile.mockResolvedValue(path)
    const dispatcher = makeDispatcher()

    await expect(
      callMobile(dispatcher, 'clipboard.saveImageAsTempFile', {
        contentBase64: Buffer.from('png-bytes').toString('base64'),
        connectionId: null
      })
    ).resolves.toMatchObject({ ok: true, result: path })

    expect(hasMobileClipboardImagePath('device-a', path)).toBe(true)
    expect(hasMobileClipboardImagePath('device-b', path)).toBe(false)
  })

  it('does not authorize a remote-host clipboard path for local structured delivery', async () => {
    const path = '/tmp/orca-paste-image.png'
    saveClipboardImageBufferAsTempFile.mockResolvedValue(path)
    const dispatcher = makeDispatcher()

    await expect(
      callMobile(dispatcher, 'clipboard.saveImageAsTempFile', {
        contentBase64: Buffer.from('png-bytes').toString('base64'),
        connectionId: 'ssh-1'
      })
    ).resolves.toMatchObject({ ok: true, result: path })

    expect(hasMobileClipboardImagePath('device-a', path)).toBe(false)
  })

  it('rejects non-base64 clipboard image payloads', async () => {
    const dispatcher = makeDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest('clipboard.saveImageAsTempFile', {
        contentBase64: 'not base64!'
      })
    )

    expect(response.ok).toBe(false)
    expect(saveClipboardImageBufferAsTempFile).not.toHaveBeenCalled()
  })

  it('rejects oversized direct clipboard image payloads before base64 validation', async () => {
    const base64Test = vi.spyOn(RegExp.prototype, 'test')
    const dispatcher = makeDispatcher()

    try {
      const response = await dispatcher.dispatch(
        makeRequest('clipboard.saveImageAsTempFile', {
          contentBase64: 'A'.repeat(CLIPBOARD_IMAGE_MAX_BASE64_CHARS + 1)
        })
      )

      expect(response).toMatchObject({ ok: false })
      expect(JSON.stringify(response)).toContain(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
      expect(base64Test).not.toHaveBeenCalled()
      expect(saveClipboardImageBufferAsTempFile).not.toHaveBeenCalled()
    } finally {
      base64Test.mockRestore()
    }
  })

  it('accepts chunked uploads and forwards the recorded connectionId on commit', async () => {
    saveClipboardImageBufferAsTempFile.mockResolvedValue('/tmp/orca-paste-image.png')
    const dispatcher = makeDispatcher()
    const contentBase64 = Buffer.from('png-bytes').toString('base64')

    const start = await dispatcher.dispatch(
      makeRequest('clipboard.startImageUpload', {
        expectedBase64Length: contentBase64.length,
        connectionId: 'ssh-1'
      })
    )
    expect(start.ok).toBe(true)
    const uploadId = (start.ok ? start.result : null) as { uploadId: string }

    const firstChunk = contentBase64.slice(0, 4)
    const secondChunk = contentBase64.slice(4)
    await expect(
      dispatcher.dispatch(
        makeRequest('clipboard.appendImageUploadChunk', {
          uploadId: uploadId.uploadId,
          offset: 0,
          contentBase64: firstChunk
        })
      )
    ).resolves.toMatchObject({ ok: true, result: { receivedBase64Length: 4 } })
    await expect(
      dispatcher.dispatch(
        makeRequest('clipboard.appendImageUploadChunk', {
          uploadId: uploadId.uploadId,
          offset: firstChunk.length,
          contentBase64: secondChunk
        })
      )
    ).resolves.toMatchObject({ ok: true, result: { receivedBase64Length: contentBase64.length } })

    await expect(
      dispatcher.dispatch(
        makeRequest('clipboard.commitImageUpload', { uploadId: uploadId.uploadId })
      )
    ).resolves.toMatchObject({ ok: true, result: '/tmp/orca-paste-image.png' })
    expect(saveClipboardImageBufferAsTempFile).toHaveBeenCalledWith(Buffer.from('png-bytes'), {
      connectionId: 'ssh-1'
    })
    expect(hasMobileClipboardImagePath('device-a', '/tmp/orca-paste-image.png')).toBe(false)
  })

  it('binds chunk mutation and provenance to the mobile client that started the upload', async () => {
    saveClipboardImageBufferAsTempFile.mockResolvedValue('/tmp/orca-paste-image.png')
    const dispatcher = makeDispatcher()
    const contentBase64 = Buffer.from('png-bytes').toString('base64')
    const start = await callMobile(dispatcher, 'clipboard.startImageUpload', {
      expectedBase64Length: contentBase64.length,
      connectionId: null
    })
    const uploadId = (start.ok ? start.result : null) as { uploadId: string }

    for (const method of [
      'clipboard.appendImageUploadChunk',
      'clipboard.commitImageUpload',
      'clipboard.abortImageUpload'
    ]) {
      const params =
        method === 'clipboard.appendImageUploadChunk'
          ? { uploadId: uploadId.uploadId, offset: 0, contentBase64 }
          : { uploadId: uploadId.uploadId }
      await expect(callMobile(dispatcher, method, params, 'device-b')).resolves.toMatchObject({
        ok: false
      })
    }

    await expect(
      callMobile(dispatcher, 'clipboard.appendImageUploadChunk', {
        uploadId: uploadId.uploadId,
        offset: 0,
        contentBase64
      })
    ).resolves.toMatchObject({
      ok: true,
      result: { receivedBase64Length: contentBase64.length }
    })
    await expect(
      callMobile(dispatcher, 'clipboard.commitImageUpload', { uploadId: uploadId.uploadId })
    ).resolves.toMatchObject({ ok: true, result: '/tmp/orca-paste-image.png' })
    expect(hasMobileClipboardImagePath('device-a', '/tmp/orca-paste-image.png')).toBe(true)
    expect(hasMobileClipboardImagePath('device-b', '/tmp/orca-paste-image.png')).toBe(false)
  })

  it('rejects out-of-order chunk offsets', async () => {
    const dispatcher = makeDispatcher()
    const start = await dispatcher.dispatch(
      makeRequest('clipboard.startImageUpload', {
        expectedBase64Length: 8,
        connectionId: null
      })
    )
    const uploadId = (start.ok ? start.result : null) as { uploadId: string }

    const response = await dispatcher.dispatch(
      makeRequest('clipboard.appendImageUploadChunk', {
        uploadId: uploadId.uploadId,
        offset: 4,
        contentBase64: 'AAAA'
      })
    )

    expect(response.ok).toBe(false)
    expect(saveClipboardImageBufferAsTempFile).not.toHaveBeenCalled()
  })

  it('rejects invalid base64 chunks and oversized chunks', async () => {
    const dispatcher = makeDispatcher()
    const start = await dispatcher.dispatch(
      makeRequest('clipboard.startImageUpload', {
        expectedBase64Length: CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS + 4,
        connectionId: null
      })
    )
    const uploadId = (start.ok ? start.result : null) as { uploadId: string }

    await expect(
      dispatcher.dispatch(
        makeRequest('clipboard.appendImageUploadChunk', {
          uploadId: uploadId.uploadId,
          offset: 0,
          contentBase64: 'not base64!'
        })
      )
    ).resolves.toMatchObject({ ok: false })
    await expect(
      dispatcher.dispatch(
        makeRequest('clipboard.appendImageUploadChunk', {
          uploadId: uploadId.uploadId,
          offset: 0,
          contentBase64: 'A'.repeat(CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS + 4)
        })
      )
    ).resolves.toMatchObject({ ok: false })
  })

  it('rejects oversized clipboard image upload chunks before base64 validation', async () => {
    const base64Test = vi.spyOn(RegExp.prototype, 'test')
    const dispatcher = makeDispatcher()
    const start = await dispatcher.dispatch(
      makeRequest('clipboard.startImageUpload', {
        expectedBase64Length: CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS + 4,
        connectionId: null
      })
    )
    const uploadId = (start.ok ? start.result : null) as { uploadId: string }

    try {
      const response = await dispatcher.dispatch(
        makeRequest('clipboard.appendImageUploadChunk', {
          uploadId: uploadId.uploadId,
          offset: 0,
          contentBase64: 'A'.repeat(CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS + 4)
        })
      )

      expect(response).toMatchObject({ ok: false })
      expect(JSON.stringify(response)).toContain('Clipboard image chunk is too large')
      expect(base64Test).not.toHaveBeenCalled()
      expect(saveClipboardImageBufferAsTempFile).not.toHaveBeenCalled()
    } finally {
      base64Test.mockRestore()
    }
  })

  it('rejects uploads beyond the existing total clipboard image limit', async () => {
    const dispatcher = makeDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest('clipboard.startImageUpload', {
        expectedBase64Length: 24 * 1024 * 1024 + 1,
        connectionId: null
      })
    )

    expect(response.ok).toBe(false)
  })

  it('rejects commit until all expected bytes arrive', async () => {
    const dispatcher = makeDispatcher()
    const start = await dispatcher.dispatch(
      makeRequest('clipboard.startImageUpload', {
        expectedBase64Length: 8,
        connectionId: null
      })
    )
    const uploadId = (start.ok ? start.result : null) as { uploadId: string }
    await dispatcher.dispatch(
      makeRequest('clipboard.appendImageUploadChunk', {
        uploadId: uploadId.uploadId,
        offset: 0,
        contentBase64: 'AAAA'
      })
    )

    const response = await dispatcher.dispatch(
      makeRequest('clipboard.commitImageUpload', { uploadId: uploadId.uploadId })
    )

    expect(response.ok).toBe(false)
    expect(saveClipboardImageBufferAsTempFile).not.toHaveBeenCalled()
  })

  it('validates the complete base64 payload before saving', async () => {
    const dispatcher = makeDispatcher()
    const start = await dispatcher.dispatch(
      makeRequest('clipboard.startImageUpload', {
        expectedBase64Length: 8,
        connectionId: null
      })
    )
    const uploadId = (start.ok ? start.result : null) as { uploadId: string }
    await dispatcher.dispatch(
      makeRequest('clipboard.appendImageUploadChunk', {
        uploadId: uploadId.uploadId,
        offset: 0,
        contentBase64: 'AA=='
      })
    )
    await dispatcher.dispatch(
      makeRequest('clipboard.appendImageUploadChunk', {
        uploadId: uploadId.uploadId,
        offset: 4,
        contentBase64: 'AAAA'
      })
    )

    const response = await dispatcher.dispatch(
      makeRequest('clipboard.commitImageUpload', { uploadId: uploadId.uploadId })
    )

    expect(response.ok).toBe(false)
    expect(saveClipboardImageBufferAsTempFile).not.toHaveBeenCalled()
  })

  it('deletes upload state after abort and treats repeated aborts as success', async () => {
    const dispatcher = makeDispatcher()
    const start = await dispatcher.dispatch(
      makeRequest('clipboard.startImageUpload', {
        expectedBase64Length: 4,
        connectionId: null
      })
    )
    const uploadId = (start.ok ? start.result : null) as { uploadId: string }

    await expect(
      dispatcher.dispatch(
        makeRequest('clipboard.abortImageUpload', { uploadId: uploadId.uploadId })
      )
    ).resolves.toMatchObject({ ok: true, result: { aborted: true } })
    await expect(
      dispatcher.dispatch(
        makeRequest('clipboard.abortImageUpload', { uploadId: uploadId.uploadId })
      )
    ).resolves.toMatchObject({ ok: true, result: { aborted: true } })
    await expect(
      dispatcher.dispatch(
        makeRequest('clipboard.commitImageUpload', { uploadId: uploadId.uploadId })
      )
    ).resolves.toMatchObject({ ok: false })
  })

  it('deletes upload state when saving fails during commit', async () => {
    saveClipboardImageBufferAsTempFile.mockRejectedValue(new Error('ssh write failed'))
    const dispatcher = makeDispatcher()
    const contentBase64 = Buffer.from('png-bytes').toString('base64')
    const start = await dispatcher.dispatch(
      makeRequest('clipboard.startImageUpload', {
        expectedBase64Length: contentBase64.length,
        connectionId: 'ssh-1'
      })
    )
    const uploadId = (start.ok ? start.result : null) as { uploadId: string }
    await dispatcher.dispatch(
      makeRequest('clipboard.appendImageUploadChunk', {
        uploadId: uploadId.uploadId,
        offset: 0,
        contentBase64
      })
    )

    await expect(
      dispatcher.dispatch(
        makeRequest('clipboard.commitImageUpload', { uploadId: uploadId.uploadId })
      )
    ).resolves.toMatchObject({ ok: false })
    await expect(
      dispatcher.dispatch(
        makeRequest('clipboard.commitImageUpload', { uploadId: uploadId.uploadId })
      )
    ).resolves.toMatchObject({ ok: false })
    expect(saveClipboardImageBufferAsTempFile).toHaveBeenCalledTimes(1)
  })

  it('bounds concurrent uploads and releases slots through TTL cleanup', async () => {
    vi.useFakeTimers()
    const dispatcher = makeDispatcher()
    for (let index = 0; index < CLIPBOARD_IMAGE_UPLOAD_MAX_CONCURRENT; index++) {
      await expect(
        dispatcher.dispatch(
          makeRequest('clipboard.startImageUpload', {
            expectedBase64Length: 4,
            connectionId: null
          })
        )
      ).resolves.toMatchObject({ ok: true })
    }
    await expect(
      dispatcher.dispatch(
        makeRequest('clipboard.startImageUpload', {
          expectedBase64Length: 4,
          connectionId: null
        })
      )
    ).resolves.toMatchObject({ ok: false })

    vi.advanceTimersByTime(5 * 60 * 1000 + 1)

    await expect(
      dispatcher.dispatch(
        makeRequest('clipboard.startImageUpload', {
          expectedBase64Length: 4,
          connectionId: null
        })
      )
    ).resolves.toMatchObject({ ok: true })
  })
})
