import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { RpcRequest, RpcResponse } from '../../core'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import '../../../../../shared/clipboard-image'

const { saveClipboardImageBufferAsTempFile } = vi.hoisted(() => ({
  saveClipboardImageBufferAsTempFile: vi.fn()
}))

vi.mock('../../../../window/clipboard-image-temp-file', () => ({
  saveClipboardImageBufferAsTempFile
}))
import '../../../../../shared/rpc-contract/clipboard-params'
import { CLIPBOARD_METHODS, resetClipboardImageUploadsForTest } from './clipboard'
import {
  hasMobileClipboardImagePath,
  resetMobileClipboardImageProvenanceForTest
} from '../../clipboard/mobile-clipboard-image-provenance'

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
})
