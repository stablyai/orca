import { stat, statfs } from 'node:fs/promises'

// Linux statfs f_type magics for network/FUSE filesystems, where inotify misses changes made by other hosts.
const LINUX_NETWORK_FS_TYPES = new Set([
  0x6969, // NFS
  0xff534d42, // CIFS
  0xfe534d42, // SMB2
  0x517b, // SMB
  0x65735546, // FUSE (sshfs, rclone, ...)
  0x01021997, // 9P
  0x5346414f, // AFS
  0x6b414653, // kAFS
  0x00c36400, // CephFS
  0x0bd00bd0, // Lustre
  0x47504653, // GPFS
  0x73757245, // Coda
  0x564c // NCP
])

/** True when native watching cannot be trusted to see every change (network shares, FUSE mounts). */
export async function isOnNetworkVolume(
  path: string,
  platform: NodeJS.Platform = process.platform,
  bootVolumePath = '/'
): Promise<boolean> {
  if (platform === 'win32') {
    return /^[\\/]{2}/.test(path)
  }
  if (platform === 'darwin') {
    // darwin statfs types are per-boot indexes; any volume but the boot one (shares, network homes, external disks) keeps the old cadence.
    try {
      const [target, boot] = await Promise.all([stat(path), stat(bootVolumePath)])
      return target.dev !== boot.dev
    } catch {
      return false
    }
  }
  if (platform !== 'linux') {
    return false
  }
  try {
    return LINUX_NETWORK_FS_TYPES.has((await statfs(path)).type)
  } catch {
    return false
  }
}
