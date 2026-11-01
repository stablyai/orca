import { describe, expect, it } from 'vitest'
import {
  parseWindowsDriveMountPoints,
  withoutWindowsDriveMountDirs
} from './wsl-guest-windows-drive-path'

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
})
