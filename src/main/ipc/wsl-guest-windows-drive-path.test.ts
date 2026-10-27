import { describe, expect, it } from 'vitest'
import {
  isWslGuestProcess,
  isWslHostOrcadProcess,
  ORCAD_WSL_HOST_ENV,
  parseWindowsDriveMountPoints,
  withoutWindowsDriveMountDirs
} from './wsl-guest-windows-drive-path'
import { buildLocalPreflightEnv } from './preflight-local-env'
import { getPreflightWslTarget } from './preflight-runtime-target'

// Captured from Ubuntu 24.04 on WSL 2.7.10 (trimmed).
const WSL2_PROC_MOUNTS = [
  'none /usr/lib/wsl/lib overlay rw,relatime 0 0',
  '/dev/sdc / ext4 rw,relatime,discard 0 0',
  'drivers /usr/lib/wsl/drivers 9p ro,nosuid,nodev,noatime,aname=drivers;fmask=222 0 0',
  'C:\\134 /mnt/c 9p rw,noatime,dirsync,aname=drvfs;path=C:\\;uid=1000 0 0',
  'D:\\134 /data/d\\040drive 9p rw,noatime,aname=drvfs;path=D:\\ 0 0',
  'tmpfs /run tmpfs rw,nosuid,nodev,mode=755 0 0'
].join('\n')

describe('Windows drive dirs on a WSL guest PATH', () => {
  it('reads drive mounts by type, wherever the automount root is', () => {
    expect(parseWindowsDriveMountPoints(WSL2_PROC_MOUNTS)).toEqual([
      '/usr/lib/wsl/drivers',
      '/mnt/c',
      '/data/d drive'
    ])
  })

  it('never treats a root mount as a drive, which would empty PATH', () => {
    expect(parseWindowsDriveMountPoints('rootfs / virtiofs rw 0 0')).toEqual([])
  })

  it('drops /mnt/<drive> entries so a Windows shim cannot answer for a Linux CLI', () => {
    const path = [
      '/home/u/.local/bin',
      '/usr/bin',
      '/mnt/c/Users/u/AppData/Roaming/npm',
      '/mnt/c/WINDOWS/system32',
      '/mnt/cache/bin',
      '/usr/lib/wsl/lib'
    ].join(':')
    expect(withoutWindowsDriveMountDirs(path, ['/mnt/c'])).toBe(
      '/home/u/.local/bin:/usr/bin:/mnt/cache/bin:/usr/lib/wsl/lib'
    )
  })

  it('leaves PATH untouched outside a WSL guest', () => {
    expect(withoutWindowsDriveMountDirs('/mnt/c/x:/usr/bin', [])).toBe('/mnt/c/x:/usr/bin')
    expect(isWslGuestProcess({}, 'linux', () => false)).toBe(false)
    expect(isWslGuestProcess({ WSL_DISTRO_NAME: 'Ubuntu' }, 'darwin', () => true)).toBe(false)
  })

  it('recognises the guest under `wsl.exe --exec` (WSL_DISTRO_NAME) or by its interop binfmt', () => {
    expect(isWslGuestProcess({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux', () => false)).toBe(true)
    expect(isWslGuestProcess({}, 'linux', () => true)).toBe(true)
  })

  it('filters only for an orcad Orca launched as a WSL host', () => {
    const guest = { WSL_DISTRO_NAME: 'Ubuntu' }
    expect(isWslHostOrcadProcess(guest, 'linux', () => true)).toBe(false)
    expect(isWslHostOrcadProcess({ ...guest, [ORCAD_WSL_HOST_ENV]: '1' }, 'linux')).toBe(true)
    expect(isWslHostOrcadProcess({ [ORCAD_WSL_HOST_ENV]: '1' }, 'linux', () => false)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'gives local preflight a PATH without the drive dirs on a guest only',
    () => {
      const original = process.env.PATH
      process.env.PATH = '/home/u/.local/bin:/mnt/c/Users/u/AppData/Roaming/npm:/usr/bin'
      try {
        expect(buildLocalPreflightEnv([])).toBeUndefined()
        expect(buildLocalPreflightEnv(['/mnt/c'])?.PATH).toBe('/home/u/.local/bin:/usr/bin')
      } finally {
        process.env.PATH = original
      }
    }
  )

  it('never treats orcad inside the guest as a WSL preflight context', () => {
    expect(getPreflightWslTarget({ wslDistro: 'Ubuntu' }, 'linux')).toBeNull()
    expect(getPreflightWslTarget({ wslDefault: true }, 'linux')).toBeNull()
  })
})
