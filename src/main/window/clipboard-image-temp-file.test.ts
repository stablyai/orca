import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { writeFileMock, mkdirMock, getPathMock, writeFileBase64Mock, unlinkMock, deletePathMock } =
  vi.hoisted(() => ({
    writeFileMock: vi.fn(),
    mkdirMock: vi.fn(),
    getPathMock: vi.fn((name: string) =>
      name === 'temp' ? '/os/temp' : '/Users/me/Library/Application Support/orca'
    ),
    writeFileBase64Mock: vi.fn(),
    unlinkMock: vi.fn(),
    deletePathMock: vi.fn()
  }))

vi.mock('node:fs/promises', () => ({
  default: { writeFile: writeFileMock, mkdir: mkdirMock, unlink: unlinkMock }
}))
vi.mock('node:crypto', () => ({ randomUUID: () => 'uuid-1' }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: getPathMock })
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: () => ({
    getTempDir: async () => '/remote/tmp',
    writeFileBase64: writeFileBase64Mock,
    deletePath: deletePathMock
  })
}))

import {
  discardClipboardImageTempFile,
  retainClipboardImageTempFile,
  saveClipboardImageBufferAsTempFile
} from './clipboard-image-temp-file'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  unlinkMock.mockResolvedValue(undefined)
  deletePathMock.mockResolvedValue(undefined)
})

afterEach(() => vi.useRealTimers())

describe('saveClipboardImageBufferAsTempFile', () => {
  it('keeps a terminal, editor or phone paste in OS temp, as before', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from([1, 2, 3]))

    expect(getPathMock).toHaveBeenCalledWith('temp')
    expect(getPathMock).not.toHaveBeenCalledWith('userData')
    expect(mkdirMock).not.toHaveBeenCalled()
    expect(dirname(savedPath)).toBe('/os/temp')
    expect(writeFileMock).toHaveBeenCalledWith(savedPath, Buffer.from([1, 2, 3]), { mode: 0o600 })
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
    expect(writeFileMock).toHaveBeenCalledWith(savedPath, Buffer.from([1, 2, 3]), { mode: 0o600 })
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

describe('clipboard image cleanup ownership', () => {
  it('deletes an admitted local file and refuses unknown paths', async () => {
    const path = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), { discardable: true })
    await discardClipboardImageTempFile(path)
    expect(unlinkMock).toHaveBeenCalledExactlyOnceWith(path)
    await expect(discardClipboardImageTempFile('/tmp/user-file.png')).rejects.toThrow('not found')
  })
  it('deletes only through the original SSH provider and matching connection', async () => {
    const path = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), {
      connectionId: 'ssh-1',
      discardable: true
    })
    await expect(discardClipboardImageTempFile(path, 'ssh-2')).rejects.toThrow('not found')
    await discardClipboardImageTempFile(path, 'ssh-1')
    expect(deletePathMock).toHaveBeenCalledExactlyOnceWith(path)
    expect(unlinkMock).not.toHaveBeenCalled()
  })
  it('retains files handed to a CLI and leaves ordinary clipboard paths unmanaged', async () => {
    const path = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), { discardable: true })
    retainClipboardImageTempFile(path, null, true)
    await expect(discardClipboardImageTempFile(path)).rejects.toThrow('not found')
    const ordinary = await saveClipboardImageBufferAsTempFile(Buffer.from([1]))
    await expect(discardClipboardImageTempFile(ordinary)).rejects.toThrow('not found')
    expect(unlinkMock).not.toHaveBeenCalled()
  })
})

it('expires unsubmitted images and retries failed deletion on their original host', async () => {
  unlinkMock
    .mockRejectedValueOnce(new Error('temporarily unavailable'))
    .mockResolvedValue(undefined)
  const path = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), { discardable: true })
  await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
  expect(unlinkMock).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(unlinkMock).toHaveBeenCalledTimes(2)
  expect(unlinkMock).toHaveBeenLastCalledWith(path)
})

it('preserves retained files across expiry and refuses retention during deletion', async () => {
  const path = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), { discardable: true })
  retainClipboardImageTempFile(path, null, true)
  await vi.advanceTimersByTimeAsync(16 * 60 * 1000)
  expect(unlinkMock).not.toHaveBeenCalled()
  let complete: (() => void) | undefined
  unlinkMock.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve
      })
  )
  const pending = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), { discardable: true })
  const deletion = discardClipboardImageTempFile(pending)
  expect(() => retainClipboardImageTempFile(pending)).toThrow('expired')
  complete?.()
  await deletion
})

it('expires retained reservations unless delivery releases ownership', async () => {
  const path = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), { discardable: true })
  retainClipboardImageTempFile(path)
  await vi.advanceTimersByTimeAsync(16 * 60 * 1000)
  expect(unlinkMock).toHaveBeenCalledWith(path)
})
