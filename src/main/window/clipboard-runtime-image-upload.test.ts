import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeEnvironmentMock } = vi.hoisted(() => ({
  callRuntimeEnvironmentMock: vi.fn()
}))

vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))

import { saveClipboardImageBufferInRuntime } from './clipboard-runtime-image-upload'

function mockRuntimeUploadMethods(
  overrides: Record<string, { ok: boolean; result?: unknown; error?: unknown }> = {}
): void {
  callRuntimeEnvironmentMock.mockImplementation(
    async (_userDataPath, _runtimeId, method, params) => {
      if (method in overrides) {
        return { ...overrides[method], _meta: { runtimeId: 'runtime-1' } }
      }
      switch (method) {
        case 'clipboard.startImageUpload':
          return { ok: true, result: { uploadId: 'upload-1' }, _meta: { runtimeId: 'runtime-1' } }
        case 'clipboard.appendImageUploadChunk':
          return {
            ok: true,
            result: {
              receivedBase64Length:
                (params as { offset: number; contentBase64: string }).offset +
                (params as { contentBase64: string }).contentBase64.length
            },
            _meta: { runtimeId: 'runtime-1' }
          }
        case 'clipboard.commitImageUpload':
          return { ok: true, result: '/tmp/orca-paste-remote.png', _meta: { runtimeId: 'r-1' } }
        case 'clipboard.abortImageUpload':
          return { ok: true, result: { aborted: true }, _meta: { runtimeId: 'runtime-1' } }
        default:
          throw new Error(`unexpected method: ${method}`)
      }
    }
  )
}

describe('saveClipboardImageBufferInRuntime', () => {
  beforeEach(() => {
    callRuntimeEnvironmentMock.mockReset()
  })

  it('starts the chunked upload with a null connection by default', async () => {
    mockRuntimeUploadMethods()
    const buffer = Buffer.from([0, 1, 2, 3])

    await expect(saveClipboardImageBufferInRuntime('/data', 'env-1', buffer)).resolves.toBe(
      '/tmp/orca-paste-remote.png'
    )
    expect(callRuntimeEnvironmentMock).toHaveBeenNthCalledWith(
      1,
      '/data',
      'env-1',
      'clipboard.startImageUpload',
      { expectedBase64Length: buffer.toString('base64').length, connectionId: null },
      30_000
    )
  })

  it('threads a server-owned SSH connection into the chunked upload start', async () => {
    mockRuntimeUploadMethods()
    const buffer = Buffer.from([0, 1, 2, 3])

    await expect(
      saveClipboardImageBufferInRuntime('/data', 'env-1', buffer, 'ssh-jetson')
    ).resolves.toBe('/tmp/orca-paste-remote.png')
    expect(callRuntimeEnvironmentMock).toHaveBeenNthCalledWith(
      1,
      '/data',
      'env-1',
      'clipboard.startImageUpload',
      { expectedBase64Length: buffer.toString('base64').length, connectionId: 'ssh-jetson' },
      30_000
    )
  })

  it('normalizes a blank connection to null before forwarding', async () => {
    // The runtime schema rejects '' (z.string().min(1)); a blank id means
    // "no connection", exactly like the desktop IPC handler treats it.
    mockRuntimeUploadMethods()
    const buffer = Buffer.from([0, 1, 2, 3])

    await expect(saveClipboardImageBufferInRuntime('/data', 'env-1', buffer, '  ')).resolves.toBe(
      '/tmp/orca-paste-remote.png'
    )
    expect(callRuntimeEnvironmentMock).toHaveBeenNthCalledWith(
      1,
      '/data',
      'env-1',
      'clipboard.startImageUpload',
      { expectedBase64Length: buffer.toString('base64').length, connectionId: null },
      30_000
    )
  })

  it('threads the connection into the single-frame fallback on older runtimes', async () => {
    const buffer = Buffer.from([0, 1, 2, 3])
    mockRuntimeUploadMethods({
      'clipboard.startImageUpload': {
        ok: false,
        error: { code: 'method_not_found', message: 'unknown method' }
      },
      'clipboard.saveImageAsTempFile': { ok: true, result: '/tmp/orca-paste-remote.png' }
    })

    await expect(
      saveClipboardImageBufferInRuntime('/data', 'env-1', buffer, 'ssh-jetson')
    ).resolves.toBe('/tmp/orca-paste-remote.png')
    expect(callRuntimeEnvironmentMock).toHaveBeenLastCalledWith(
      '/data',
      'env-1',
      'clipboard.saveImageAsTempFile',
      { contentBase64: buffer.toString('base64'), connectionId: 'ssh-jetson' },
      30_000
    )
  })

  it('aborts the upload when a chunk fails', async () => {
    const buffer = Buffer.alloc(512 * 1024)
    mockRuntimeUploadMethods({
      'clipboard.appendImageUploadChunk': {
        ok: false,
        error: { code: 'runtime_error', message: 'append failed' }
      }
    })

    await expect(saveClipboardImageBufferInRuntime('/data', 'env-1', buffer)).rejects.toThrow(
      'append failed'
    )
    expect(callRuntimeEnvironmentMock).toHaveBeenLastCalledWith(
      '/data',
      'env-1',
      'clipboard.abortImageUpload',
      { uploadId: 'upload-1' },
      30_000
    )
  })
})
