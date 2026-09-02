import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
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

describe('probeMacosFullDiskAccess', () => {
  it('reports granted only when the TCC database opens for reading', async () => {
    const readProbe = vi.fn().mockResolvedValue(undefined)

    await expect(probeMacosFullDiskAccess({ homeDirectory, readProbe })).resolves.toBe('granted')
    expect(readProbe).toHaveBeenCalledWith(databasePath)
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
