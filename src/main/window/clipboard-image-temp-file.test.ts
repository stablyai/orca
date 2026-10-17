import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../providers/ssh-host-not-served-error'
import { createTerminalImageAttachmentLease } from '../../renderer/src/components/terminal-pane/terminal-image-attachment-lease'

const { writeFileMock, mkdirMock, getPathMock, unlinkMock } = vi.hoisted(() => ({
  writeFileMock: vi.fn(),
  mkdirMock: vi.fn(),
  getPathMock: vi.fn((name: string) =>
    name === 'temp' ? '/os/temp' : '/Users/me/Library/Application Support/orca'
  ),
  unlinkMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  default: { writeFile: writeFileMock, mkdir: mkdirMock, unlink: unlinkMock }
}))
vi.mock('node:crypto', () => ({ randomUUID: () => 'uuid-1' }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: getPathMock })
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

  it.each([false, true])(
    'refuses an unserved SSH target with discardable=%s before local writes',
    async (discardable) => {
      await expect(
        saveClipboardImageBufferAsTempFile(Buffer.from([1]), {
          connectionId: 'ssh-unserved',
          discardable,
          forNativeChatDraft: true
        })
      ).rejects.toThrow(SSH_HOST_NOT_SERVED_MESSAGE)
      expect(getPathMock).not.toHaveBeenCalled()
      expect(mkdirMock).not.toHaveBeenCalled()
      expect(writeFileMock).not.toHaveBeenCalled()
      expect(unlinkMock).not.toHaveBeenCalled()
    }
  )
})

describe('clipboard image cleanup ownership', () => {
  it('deletes an admitted local file and refuses unknown paths', async () => {
    const path = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), { discardable: true })
    await discardClipboardImageTempFile(path)
    expect(unlinkMock).toHaveBeenCalledExactlyOnceWith(path)
    await expect(discardClipboardImageTempFile('/tmp/user-file.png')).rejects.toThrow('not found')
  })
  it('refuses a mismatched connection without deleting an admitted local file', async () => {
    const path = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), {
      discardable: true
    })
    await expect(discardClipboardImageTempFile(path, 'ssh-2')).rejects.toThrow('not found')
    expect(unlinkMock).not.toHaveBeenCalled()
    await discardClipboardImageTempFile(path)
    expect(unlinkMock).toHaveBeenCalledExactlyOnceWith(path)
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

it('retries delivery when the host applied release but its acknowledgement was lost', async () => {
  const path = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), { discardable: true })
  let loseAcknowledgement = true
  const onError = vi.fn()
  const settle = vi.fn(async (action: 'discard' | 'retain' | 'release') => {
    if (action === 'discard') {
      await discardClipboardImageTempFile(path)
      return
    }
    retainClipboardImageTempFile(path, null, action === 'release')
    if (action === 'release' && loseAcknowledgement) {
      loseAcknowledgement = false
      throw new Error('Release acknowledgement lost')
    }
  })
  const lease = createTerminalImageAttachmentLease({ isCurrent: () => true, settle, onError })
  const deliver = vi.fn()
  const attemptDelivery = async () => {
    if (!(await lease.prepareDelivery())) {
      return false
    }
    await lease.deliveryStarted()
    deliver(path)
    return true
  }

  await expect(attemptDelivery()).rejects.toThrow('acknowledgement lost')
  expect(deliver).not.toHaveBeenCalled()
  await expect(discardClipboardImageTempFile(path)).rejects.toThrow('not found')
  expect(await attemptDelivery()).toBe(true)
  expect(deliver).toHaveBeenCalledExactlyOnceWith(path)
  lease.cancel()
  await vi.advanceTimersByTimeAsync(16 * 60 * 1000)

  expect(settle.mock.calls).toEqual([['retain'], ['release'], ['retain'], ['release']])
  expect(onError).not.toHaveBeenCalled()
  expect(unlinkMock).not.toHaveBeenCalled()
})

it('bounds released retry records and preserves handed-off file ownership', async () => {
  const path = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), { discardable: true })
  retainClipboardImageTempFile(path, null, true)
  await vi.advanceTimersByTimeAsync(14 * 60 * 1000)

  expect(() => retainClipboardImageTempFile(path, 'wrong-owner')).toThrow('not found')
  expect(() => retainClipboardImageTempFile(path, 'wrong-owner', true)).toThrow('not found')
  await expect(discardClipboardImageTempFile(path, 'wrong-owner')).rejects.toThrow('not found')
  await expect(discardClipboardImageTempFile(path)).rejects.toThrow('not found')
  await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
  expect(() => retainClipboardImageTempFile(path)).toThrow('not found')
  expect(unlinkMock).not.toHaveBeenCalled()
})

it('refreshes released retry bookkeeping without reclaiming handed-off files', async () => {
  const path = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), { discardable: true })
  retainClipboardImageTempFile(path, null, true)
  await vi.advanceTimersByTimeAsync(14 * 60 * 1000)
  retainClipboardImageTempFile(path)
  retainClipboardImageTempFile(path, null, true)
  await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
  retainClipboardImageTempFile(path)
  await expect(discardClipboardImageTempFile(path)).rejects.toThrow('not found')

  await vi.advanceTimersByTimeAsync(16 * 60 * 1000)
  expect(() => retainClipboardImageTempFile(path)).toThrow('not found')
  expect(unlinkMock).not.toHaveBeenCalled()
})
