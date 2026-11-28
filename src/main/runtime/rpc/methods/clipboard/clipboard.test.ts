import { describe, expect, it } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { RpcContext, RpcResponse } from '../../core'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../../../../../shared/rpc-contract/clipboard/clipboard-params'
import { appendClipboardImageUploadChunks } from '../../../../../shared/clipboard/clipboard-image-chunk-upload'
import { CLIPBOARD_METHODS, claimClipboardImageUpload } from './clipboard'

function createHost() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the upload methods read only the runtime id.
  const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: CLIPBOARD_METHODS })
  const call = (method: string, params: unknown): Promise<RpcResponse> =>
    dispatcher.dispatch({ id: method, authToken: 'tok', method, params })
  const start = async (contentBase64: string) => {
    const response = await call('clipboard.startImageUpload', {
      expectedBase64Length: contentBase64.length
    })
    expect(response.ok && response.result).toMatchObject({ acceptsOutOfOrderChunks: true })
    const uploadId =
      response.ok &&
      response.result &&
      typeof response.result === 'object' &&
      'uploadId' in response.result
        ? String(response.result.uploadId)
        : ''
    return uploadId
  }
  const ctx: RpcContext = { runtime }
  const claim = (uploadId: string) => claimClipboardImageUpload(uploadId, ctx)
  return { call, start, claim }
}

describe('clipboard image upload', () => {
  it('reassembles chunks that arrive out of order and rejects a repeated offset', async () => {
    const host = createHost()
    const bytes = Buffer.from(Array.from({ length: 30 }, (_, index) => index * 7))
    const contentBase64 = bytes.toString('base64')
    const uploadId = await host.start(contentBase64)
    const append = (offset: number) =>
      host.call('clipboard.appendImageUploadChunk', {
        uploadId,
        offset,
        contentBase64: contentBase64.slice(offset, offset + 12)
      })

    expect((await append(24)).ok).toBe(true)
    expect((await append(36)).ok).toBe(true)
    expect((await append(36)).ok).toBe(false)
    expect((await append(0)).ok).toBe(true)
    expect((await append(0)).ok).toBe(false)
    expect((await append(12)).ok).toBe(true)

    expect(host.claim(uploadId)).toEqual(bytes)
  })

  it('keeps early chunks under the host cap while the second chunk is slow', async () => {
    const host = createHost()
    const bytes = Buffer.alloc((CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS / 4) * 3 * 20)
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251
    }
    const contentBase64 = bytes.toString('base64')
    const uploadId = await host.start(contentBase64)

    await appendClipboardImageUploadChunks(
      { uploadId, acceptsOutOfOrderChunks: true },
      contentBase64,
      async (chunk) => {
        if (chunk.offset === CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        const response = await host.call('clipboard.appendImageUploadChunk', chunk)
        if (!response.ok) {
          throw new Error(response.error.message)
        }
      },
      30_000
    )

    expect(host.claim(uploadId).equals(bytes)).toBe(true)
  })
})
