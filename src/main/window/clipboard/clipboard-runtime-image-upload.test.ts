import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ callRuntimeEnvironment: vi.fn() }))

vi.mock('../../ipc/runtime-environments/requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))

import { saveClipboardImageBufferInRuntime } from './clipboard-runtime-image-upload'

function serverSavingAt(savedPath: string): void {
  mocks.callRuntimeEnvironment.mockImplementation(async (_userData, _env, method: string) => {
    if (method === 'clipboard.startImageUpload') {
      return { ok: true, result: { uploadId: 'u1' } }
    }
    if (method === 'clipboard.commitImageUpload') {
      return { ok: true, result: savedPath }
    }
    return { ok: true, result: null }
  })
}

describe('saveClipboardImageBufferInRuntime with a file name', () => {
  beforeEach(() => {
    mocks.callRuntimeEnvironment.mockReset()
  })

  // An older server drops `fileName` and saves the bytes as a pasted PNG.
  it('refuses a document an older server saved as an image', async () => {
    serverSavingAt('/tmp/orca-paste-1794238543599-a5460176-53af-4cac-a867-61a9f3277198.png')
    await expect(
      saveClipboardImageBufferInRuntime(
        '/tmp/user-data',
        'env-1',
        Buffer.from('# notes'),
        null,
        'notes.md'
      )
    ).rejects.toThrow('The Orca server is too old to keep file names. Update it and try again.')
  })
})
