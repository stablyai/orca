import { describe, expect, it } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { RpcContext, RpcResponse } from '../../core'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { CLIPBOARD_METHODS, claimClipboardImageUpload } from './clipboard'

describe('clipboard image upload', () => {
  it('reassembles chunks that arrive out of order and rejects a repeated offset', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the upload methods read only the runtime id.
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIPBOARD_METHODS })
    const call = (method: string, params: unknown): Promise<RpcResponse> =>
      dispatcher.dispatch({ id: method, authToken: 'tok', method, params })
    const bytes = Buffer.from(Array.from({ length: 30 }, (_, index) => index * 7))
    const contentBase64 = bytes.toString('base64')

    const start = await call('clipboard.startImageUpload', {
      expectedBase64Length: contentBase64.length
    })
    expect(start.ok && start.result).toMatchObject({ acceptsOutOfOrderChunks: true })
    const uploadId =
      start.ok && start.result && typeof start.result === 'object' && 'uploadId' in start.result
        ? String(start.result.uploadId)
        : ''
    const append = (offset: number) =>
      call('clipboard.appendImageUploadChunk', {
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

    const ctx: RpcContext = { runtime }
    expect(claimClipboardImageUpload(uploadId, ctx)).toEqual(bytes)
  })
})
