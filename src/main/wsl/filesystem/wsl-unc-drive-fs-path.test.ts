import { describe, expect, it, vi } from 'vitest'
import {
  realpathAcrossWslDriveMount,
  windowsFsPath,
  wslUncDriveFsPath
} from './wsl-unc-drive-fs-path'

const UNC = String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`

// WSL 2.7 refuses every Windows access to a drive mount over UNC.
const deniedOnUnc = vi.fn(async (path: string): Promise<string> => {
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    throw Object.assign(new Error(`EPERM: operation not permitted, realpath '${path}'`), {
      code: 'EPERM'
    })
  }
  return path
})

describe('wslUncDriveFsPath', () => {
  it('opens a UNC drive-mount path through its drive, in either UNC spelling', () => {
    expect(wslUncDriveFsPath(UNC, 'win32')).toBe(String.raw`C:\src\app`)
    expect(wslUncDriveFsPath('//wsl$/Ubuntu/mnt/d/x', 'win32')).toBe(String.raw`D:\x`)
    expect(wslUncDriveFsPath(String.raw`\\wsl.localhost\Ubuntu\mnt\c`, 'win32')).toBe('C:\\')
  })

  it('leaves distro folders, other paths and other platforms alone', () => {
    expect(wslUncDriveFsPath(String.raw`\\wsl.localhost\Ubuntu\home\me\app`, 'win32')).toBeNull()
    expect(wslUncDriveFsPath(String.raw`C:\src\app`, 'win32')).toBeNull()
    expect(wslUncDriveFsPath(String.raw`\\server\share\mnt\c`, 'win32')).toBeNull()
    expect(wslUncDriveFsPath(UNC, 'linux')).toBeNull()
    expect(windowsFsPath('/home/me/app', 'darwin')).toBe('/home/me/app')
  })
})

describe('realpathAcrossWslDriveMount', () => {
  it('resolves through the drive and answers in the caller’s UNC spelling', async () => {
    const deps = { realpath: deniedOnUnc, platform: 'win32' as const }
    await expect(realpathAcrossWslDriveMount(UNC, deps)).resolves.toBe(UNC)
    await expect(
      realpathAcrossWslDriveMount(String.raw`\\wsl$\Ubuntu\mnt\c\src\app`, deps)
    ).resolves.toBe(String.raw`\\wsl$\Ubuntu\mnt\c\src\app`)
  })

  it('follows a link to another drive, and keeps a target off any drive as it is', async () => {
    const linked = {
      realpath: async (path: string) => (path === String.raw`C:\src\app` ? 'D:\\real' : path),
      platform: 'win32' as const
    }
    await expect(realpathAcrossWslDriveMount(UNC, linked)).resolves.toBe(
      String.raw`\\wsl.localhost\Ubuntu\mnt\d\real`
    )
    const share = {
      realpath: async () => String.raw`\\server\share\app`,
      platform: 'win32' as const
    }
    await expect(realpathAcrossWslDriveMount(UNC, share)).resolves.toBe(
      String.raw`\\server\share\app`
    )
  })

  it('realpaths a distro folder as it is', async () => {
    const home = String.raw`\\wsl.localhost\Ubuntu\home\me`
    const realpath = vi.fn(async (path: string) => path)
    await expect(realpathAcrossWslDriveMount(home, { realpath, platform: 'win32' })).resolves.toBe(
      home
    )
    expect(realpath).toHaveBeenCalledWith(home)
  })
})
