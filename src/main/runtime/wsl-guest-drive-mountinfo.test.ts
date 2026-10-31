import { describe, expect, it } from 'vitest'
import { parseWindowsDriveMountInfo } from './wsl-guest-drive-mountinfo'

// Shaped after Ubuntu 24.04 on WSL 2 /proc/self/mountinfo (trimmed), plus the cases a prefill must not guess.
const MOUNTINFO = [
  '30 1 8:32 / / rw,relatime - ext4 /dev/sdc rw,discard',
  '41 30 0:39 / /usr/lib/wsl/drivers ro,nosuid - 9p drivers ro,aname=drivers;fmask=222',
  '57 30 0:52 / /mnt/c rw,noatime - 9p C:\\134 rw,dirsync,aname=drvfs;path=C:\\;uid=1000',
  '58 30 0:53 / /data/d\\040drive rw,noatime - 9p D:\\134 rw,aname=drvfs;path=D:\\',
  '59 30 0:54 / /mnt/z rw,noatime - 9p \\134\\134server\\134share rw,aname=drvfs;path=\\\\server\\share',
  '60 30 0:52 /Users/me /home/me/win rw,noatime - 9p C:\\134 rw,aname=drvfs;path=C:\\',
  '61 30 0:55 / /mnt/e rw - virtiofs drvfsE rw',
  '62 30 0:20 / /mnt/wslg rw - tmpfs none rw'
].join('\n')

describe('parseWindowsDriveMountInfo', () => {
  it('finds drive mounts and prefills only a whole drive named by letter', () => {
    expect(parseWindowsDriveMountInfo(MOUNTINFO)).toEqual([
      { mountPoint: '/mnt/c', windowsRoot: 'C:\\' },
      { mountPoint: '/data/d drive', windowsRoot: 'D:\\' },
      // A drvfs mount of a network share: refused, but no C:\ guess.
      { mountPoint: '/mnt/z', windowsRoot: null },
      // A bind of a drive subfolder: refused, but the root field says it is not the drive root.
      { mountPoint: '/home/me/win', windowsRoot: null },
      { mountPoint: '/mnt/e', windowsRoot: null }
    ])
  })

  it('skips 9p shares that are not drvfs, and malformed lines', () => {
    expect(
      parseWindowsDriveMountInfo(
        '41 30 0:39 / /usr/lib/wsl/drivers ro - 9p drivers ro,aname=drivers\nnot a mount line'
      )
    ).toEqual([])
  })
})
