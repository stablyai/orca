// Judge legacy machine-less lock records by PID only on local disks; shared homes may belong to other hosts.
import { statfsSync } from 'node:fs'
import process from 'node:process'

// Local disk/memory filesystem IDs from linux/magic.h.
const LINUX_LOCAL_FILESYSTEM_MAGICS = new Set([
  0xef53, // ext2/3/4
  0x58465342, // xfs
  0x9123683e, // btrfs
  0x2fc12fc1, // zfs
  0xca451a4e, // bcachefs
  0xf2f52010, // f2fs
  0x3153464a, // jfs
  0x52654973, // reiserfs
  0x3434, // nilfs
  0x01021994, // tmpfs
  0x858458f6, // ramfs
  0x794c7630, // overlayfs
  0xf15f, // ecryptfs
  0x4d44, // vfat
  0x2011bab0, // exfat
  0x482b // hfsplus
])

export function orcadDataRootIsOnLocalDisk(
  dataRoot: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32') {
    // Device-prefixed drive paths are local; other UNC paths are shares. Mapped drives rely on writer MachineGuid.
    return !/^[\\/]{2}/u.test(dataRoot) || /^[\\/]{2}[?.][\\/][a-z]:/iu.test(dataRoot)
  }
  try {
    return filesystemTypeIsLocalDisk(
      platform,
      statfsSync(dataRoot).type,
      () => statfsSync('/').type
    )
  } catch {
    return false
  }
}

export function filesystemTypeIsLocalDisk(
  platform: string,
  type: number,
  rootType: () => number | null
): boolean {
  if (platform === 'linux') {
    return LINUX_LOCAL_FILESYSTEM_MAGICS.has(type)
  }
  // macOS assigns type numbers per loaded driver; match the local boot volume’s type.
  return platform === 'darwin' && type === rootType()
}
