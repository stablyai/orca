import { describe, expect, it } from 'vitest'
import {
  classifyIcloudSetting,
  classifyStatFlags,
  classifyVolumeType
} from '../tcc-denial-folder-state'

function ok(stdout: string, code = 0, stderr = '') {
  return { code, timedOut: false, stdout, stderr }
}

describe('folder state enums', () => {
  it('reads SF_DATALESS from `stat -f %Xf`', () => {
    expect(classifyStatFlags(ok('40000000\n'))).toBe('yes')
    expect(classifyStatFlags(ok('40000040\n'))).toBe('yes')
    expect(classifyStatFlags(ok('0\n'))).toBe('no')
    expect(classifyStatFlags(ok('', 1))).toBe('unknown')
  })

  it('treats a never-written Finder key as iCloud off', () => {
    expect(classifyIcloudSetting(ok('1\n'))).toBe('yes')
    expect(classifyIcloudSetting(ok('0\n'))).toBe('no')
    expect(
      classifyIcloudSetting(
        ok(
          '',
          1,
          'The domain/default pair of (com.apple.finder, FXICloudDriveDesktop) does not exist'
        )
      )
    ).toBe('no')
    expect(classifyIcloudSetting({ ...ok(''), timedOut: true })).toBe('unknown')
  })

  it('picks the longest mount point that contains the folder', () => {
    const mounts = ok(
      [
        '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
        '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
        '//user@nas/home on /Volumes/home (smbfs, nodev, nosuid, mounted by user)',
        '/dev/disk5s1 on /Volumes/home backup (exfat, local, nodev, nosuid, noowners)'
      ].join('\n')
    )
    expect(classifyVolumeType(mounts, '/Volumes/home/Documents')).toBe('smbfs')
    expect(classifyVolumeType(mounts, '/Volumes/home backup/Documents')).toBe('exfat')
    expect(classifyVolumeType(mounts, '/Users/user/Documents')).toBe('apfs')
    expect(
      classifyVolumeType(ok('map auto_home on /System/Volumes/Data/home (autofs)'), '/x')
    ).toBe('unknown')
  })
})
