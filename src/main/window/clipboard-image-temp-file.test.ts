import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  authorizeExternalPathMock,
  writeFileMock,
  getPathMock,
  writeFileBase64Mock,
  unlinkMock,
  deletePathMock
} = vi.hoisted(() => ({
  authorizeExternalPathMock: vi.fn(),
  writeFileMock: vi.fn(),
  getPathMock: vi.fn(() => '/var/folders/ab/T'),
  writeFileBase64Mock: vi.fn(),
  unlinkMock: vi.fn(),
  deletePathMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ default: { writeFile: writeFileMock, unlink: unlinkMock } }))
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
vi.mock('../ipc/filesystem-auth', () => ({ authorizeExternalPath: authorizeExternalPathMock }))

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
  it('authorizes the local temp file so the composer can preview what it just wrote', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from([1, 2, 3]))

    expect(writeFileMock).toHaveBeenCalledWith(savedPath, Buffer.from([1, 2, 3]), { mode: 0o600 })
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
