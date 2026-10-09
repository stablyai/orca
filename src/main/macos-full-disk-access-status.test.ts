import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
const { readMock, closeMock, openMock } = vi.hoisted(() => ({
  readMock: vi.fn(),
  closeMock: vi.fn(),
  openMock: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ open: openMock }))
import {
  getMacosFullDiskAccessStatus,
  probeMacosFullDiskAccess
} from './macos-full-disk-access-status'

const originalPlatform = process.platform
const homeDirectory = join('Users', 'tester')
const databasePath = join(
  homeDirectory,
  'Library',
  'Application Support',
  'com.apple.TCC',
  'TCC.db'
)

function fileSystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})
beforeEach(() => {
  readMock.mockReset().mockResolvedValue({ bytesRead: 1 })
  closeMock.mockReset().mockResolvedValue(undefined)
  openMock.mockReset().mockResolvedValue({ read: readMock, close: closeMock })
})

describe('probeMacosFullDiskAccess', () => {
  it('reports granted only when the TCC database can be read', async () => {
    const readProbe = vi.fn().mockResolvedValue(undefined)

    await expect(probeMacosFullDiskAccess({ homeDirectory, readProbe })).resolves.toBe('granted')
    expect(readProbe).toHaveBeenCalledWith(databasePath)
  })

  it('reads only one discarded byte and closes the handle', async () => {
    expect(await probeMacosFullDiskAccess({ homeDirectory })).toBe('granted')
    expect(openMock).toHaveBeenCalledWith(databasePath, 'r')
    expect(readMock).toHaveBeenCalledWith(expect.any(Buffer), 0, 1, 0)
    expect(readMock.mock.calls[0]?.[0].length).toBe(1)
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('does not mistake an allowed open for allowed contents, and closes after denial', async () => {
    readMock.mockRejectedValueOnce(fileSystemError('EPERM'))
    expect(await probeMacosFullDiskAccess({ homeDirectory })).toBe('denied')
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it.each(['EACCES', 'EPERM'])('reports denied for %s', async (code) => {
    await expect(
      probeMacosFullDiskAccess({
        homeDirectory,
        readProbe: async () => {
          throw fileSystemError(code)
        }
      })
    ).resolves.toBe('denied')
  })

  it.each(['ENOENT', 'ENOTDIR', 'EBUSY'])('keeps %s failures unknown', async (code) => {
    await expect(
      probeMacosFullDiskAccess({
        homeDirectory,
        readProbe: async () => {
          throw fileSystemError(code)
        }
      })
    ).resolves.toBe('unknown')
  })
})

describe('getMacosFullDiskAccessStatus', () => {
  it('is unsupported off macOS', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })

    await expect(getMacosFullDiskAccessStatus()).resolves.toBe('unsupported')
  })
})
