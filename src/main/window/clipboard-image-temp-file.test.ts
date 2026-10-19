import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { writeFileMock, mkdirMock, getPathMock } = vi.hoisted(() => ({
  writeFileMock: vi.fn(),
  mkdirMock: vi.fn(),
  getPathMock: vi.fn((name: string) =>
    name === 'temp' ? '/os/temp' : '/Users/me/Library/Application Support/orca'
  )
}))

vi.mock('node:fs/promises', () => ({ default: { writeFile: writeFileMock, mkdir: mkdirMock } }))
vi.mock('node:crypto', () => ({ randomUUID: () => 'uuid-1' }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: getPathMock })
}))

import { saveClipboardImageBufferAsTempFile } from './clipboard-image-temp-file'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('saveClipboardImageBufferAsTempFile', () => {
  it('keeps a terminal, editor or phone paste in OS temp, as before', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from([1, 2, 3]))

    expect(getPathMock).toHaveBeenCalledWith('temp')
    expect(getPathMock).not.toHaveBeenCalledWith('userData')
    expect(mkdirMock).not.toHaveBeenCalled()
    expect(dirname(savedPath)).toBe('/os/temp')
    expect(writeFileMock).toHaveBeenCalledWith(savedPath, Buffer.from([1, 2, 3]))
  })

  it('writes a native-chat composer paste into the paste folder, where its draft can find it', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from([1, 2, 3]), {
      forNativeChatDraft: true
    })

    expect(mkdirMock).toHaveBeenCalledWith(
      join('/Users/me/Library/Application Support/orca', 'native-chat-pastes'),
      { recursive: true }
    )
    expect(dirname(savedPath)).toBe(
      join('/Users/me/Library/Application Support/orca', 'native-chat-pastes')
    )
    expect(writeFileMock).toHaveBeenCalledWith(savedPath, Buffer.from([1, 2, 3]))
  })
})
