import { beforeEach, describe, expect, it, vi } from 'vitest'

const { writeFileMock, getPathMock, writeFileBase64Mock } = vi.hoisted(() => ({
  writeFileMock: vi.fn(),
  getPathMock: vi.fn(() => '/var/folders/ab/T'),
  writeFileBase64Mock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ default: { writeFile: writeFileMock } }))
vi.mock('node:crypto', () => ({ randomUUID: () => 'uuid-1' }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: getPathMock })
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: () => ({
    getTempDir: async () => '/remote/tmp',
    writeFileBase64: writeFileBase64Mock
  })
}))

import { saveClipboardImageBufferAsTempFile } from './clipboard-image-temp-file'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('saveClipboardImageBufferAsTempFile', () => {
  it('writes the pasted image to the local temp folder', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from([1, 2, 3]))

    expect(savedPath.startsWith('/var/folders/ab/T')).toBe(true)
    expect(writeFileMock).toHaveBeenCalledWith(savedPath, Buffer.from([1, 2, 3]))
  })

  it('writes an SSH paste to the remote temp folder', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), {
      connectionId: 'conn-1'
    })

    expect(savedPath.startsWith('/remote/tmp/')).toBe(true)
    expect(writeFileBase64Mock).toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})
