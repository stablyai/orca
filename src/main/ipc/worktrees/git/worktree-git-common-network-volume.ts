import { realpath } from 'node:fs'
import { stat, statfs } from 'node:fs/promises'
import { promisify } from 'node:util'

const realpathNative = promisify(realpath.native)

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

const isUncPath = (path: string): boolean => /^[\\/]{2}/.test(path)

/** True when native watching cannot be trusted to see every change (network shares, FUSE mounts). */
export async function isOnNetworkVolume(
  path: string,
  platform: NodeJS.Platform = process.platform,
  bootVolumePaths: readonly string[] = ['/', '/System/Volumes/Data']
): Promise<boolean> {
  if (platform === 'win32') {
    if (isUncPath(path)) {
      return true
    }
    // Mapped and subst drives resolve to their UNC or underlying path.
    try {
      return isUncPath(await realpathNative(path))
    } catch {
      return false
    }
  }
  if (platform === 'darwin') {
    // darwin statfs types are per-boot indexes; any volume but the startup System/Data pair (shares, network homes, external disks) keeps the old cadence.
    try {
      const target = await stat(path)
      const startup = await Promise.all(
        bootVolumePaths.map((volume) =>
          stat(volume)
            .then((s) => s.dev)
            .catch(() => null)
        )
      )
      // No readable startup volume: stay local rather than guess.
      return startup.some((dev) => dev !== null) && !startup.includes(target.dev)
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
