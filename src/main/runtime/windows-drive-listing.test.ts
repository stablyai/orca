import { describe, expect, it } from 'vitest'
import type { Stats } from 'node:fs'
import { isServerDriveListRequest, listWindowsDrives } from './windows-drive-listing'

describe('isServerDriveListRequest', () => {
  it('matches root browses only on win32', () => {
    expect(isServerDriveListRequest('/', 'win32')).toBe(true)
    expect(isServerDriveListRequest('\\', 'win32')).toBe(true)
    expect(isServerDriveListRequest('  /  ', 'win32')).toBe(true)
    expect(isServerDriveListRequest('/', 'darwin')).toBe(false)
    expect(isServerDriveListRequest('/', 'linux')).toBe(false)
  })

  it('does not intercept non-root paths on win32', () => {
    expect(isServerDriveListRequest('C:\\', 'win32')).toBe(false)
    expect(isServerDriveListRequest('/Users', 'win32')).toBe(false)
    expect(isServerDriveListRequest('~', 'win32')).toBe(false)
    expect(isServerDriveListRequest('', 'win32')).toBe(false)
  })
})

describe('listWindowsDrives', () => {
  const statOnly = (mounted: string[]) => async (p: string) => {
    if (!mounted.includes(p)) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return { isDirectory: () => true } as Stats
  }

  it('returns one directory entry per mounted drive, anchored at the host root', async () => {
    const result = await listWindowsDrives(statOnly(['C:\\', 'M:\\']))
    expect(result.resolvedPath).toBe('/')
    expect(result.pathFlavor).toBe('win32')
    expect(result.entries).toEqual([
      { name: 'C:\\', isDirectory: true, isSymlink: false },
      { name: 'M:\\', isDirectory: true, isSymlink: false }
    ])
  })

  it('skips letters whose stat fails or is not a directory', async () => {
    const statPath = async (p: string): Promise<Stats> => {
      if (p === 'C:\\') {
        return { isDirectory: () => true } as Stats
      }
      if (p === 'D:\\') {
        return { isDirectory: () => false } as Stats
      }
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    }
    const result = await listWindowsDrives(statPath)
    expect(result.entries.map((e) => e.name)).toEqual(['C:\\'])
  })

  it.each(['EIO', 'EMFILE'])('surfaces systemic %s failures', async (code) => {
    const statPath = async (p: string): Promise<Stats> => {
      if (p === 'D:\\') {
        throw Object.assign(new Error(code), { code })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }

    await expect(listWindowsDrives(statPath)).rejects.toMatchObject({ code })
  })
})
