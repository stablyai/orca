import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  authorizeExternalPathMock,
  writeFileMock,
  getPathMock,
  writeFileBase64Mock,
  saveNativeChatAttachmentFileMock
} = vi.hoisted(() => ({
  authorizeExternalPathMock: vi.fn(),
  writeFileMock: vi.fn(),
  getPathMock: vi.fn(() => '/var/folders/ab/T'),
  writeFileBase64Mock: vi.fn(),
  saveNativeChatAttachmentFileMock: vi.fn(async (fileName: string) => `/user-data/chat/${fileName}`)
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
vi.mock('../ipc/filesystem-auth', () => ({ authorizeExternalPath: authorizeExternalPathMock }))
vi.mock('./native-chat-attachment-store', () => ({
  saveNativeChatAttachmentFile: saveNativeChatAttachmentFileMock
}))

import { saveClipboardImageBufferAsTempFile } from './clipboard-image-temp-file'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('saveClipboardImageBufferAsTempFile', () => {
  it('authorizes the local temp file so the composer can preview what it just wrote', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from([1, 2, 3]))

    expect(writeFileMock).toHaveBeenCalledWith(savedPath, Buffer.from([1, 2, 3]))
    // The OS temp dir is outside every allowed root, so an unauthorized path
    // makes fs:readFile deny the preview read of Orca's own file.
    expect(authorizeExternalPathMock).toHaveBeenCalledWith(savedPath)
  })

  it('does not authorize a local path for an SSH save', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), {
      connectionId: 'conn-1'
    })

    expect(savedPath.startsWith('/remote/tmp/')).toBe(true)
    expect(writeFileBase64Mock).toHaveBeenCalled()
    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
  })

  // A chat draft can hold the image across a reboot, which OS temp does not survive.
  it("keeps a chat attachment in Orca's attachment storage, not OS temp", async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), {
      chatAttachment: true
    })

    expect(savedPath.startsWith('/user-data/chat/orca-paste-')).toBe(true)
    expect(saveNativeChatAttachmentFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/^orca-paste-.+\.png$/),
      Buffer.from([1])
    )
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})
