import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

function readIdentity(profile: string) {
  if (!isAbsolute(profile)) {
    throw new Error('ssh_reset_profile_identity_unavailable')
  }
  try {
    const path = realpathSync.native(profile)
    const stat = statSync(path, { bigint: true })
    if (!stat.isDirectory() || stat.ino <= 0n) {
      throw new Error('directory identity unavailable')
    }
    return { path, device: stat.dev, inode: stat.ino, birth: stat.birthtimeNs }
  } catch {
    throw new Error('ssh_reset_profile_identity_unavailable')
  }
}

/** Filesystem identity snapshots only; this does not exclude another profile owner. */
export function captureSshResetProfileIdentity(profile: string) {
  const identity = readIdentity(profile)
  const assertCurrent = () => {
    const current = readIdentity(profile)
    if (
      current.path !== identity.path ||
      current.device !== identity.device ||
      current.inode !== identity.inode ||
      current.birth !== identity.birth
    ) {
      throw new Error('ssh_reset_profile_identity_changed')
    }
  }
  assertCurrent()
  return {
    physicalPath: identity.path,
    filesystemIdentity: Object.freeze({
      device: String(identity.device),
      inode: String(identity.inode),
      birth: String(identity.birth)
    }),
    assertCurrent
  }
}
