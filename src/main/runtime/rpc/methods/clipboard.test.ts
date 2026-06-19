import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'

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

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeDispatcher(): RpcDispatcher {
  const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: CLIPBOARD_METHODS })
}

describe('clipboard RPC methods', () => {
  beforeEach(() => {
    saveClipboardImageBufferAsTempFile.mockReset()
    resetClipboardImageUploadsForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetClipboardImageUploadsForTest()
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
