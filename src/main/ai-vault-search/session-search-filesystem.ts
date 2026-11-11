import { runProcess } from '@orca/process-host'
import { statfs } from 'node:fs/promises'
import { isWslUncPath } from '../../shared/wsl-paths'

let mounts: { at: number; result: Promise<string[] | undefined> } | undefined

/** Native notifications cannot establish freshness when another host writes a shared mount. */
export async function sessionSearchRequiresPolling(path: string): Promise<boolean> {
  if (isWslUncPath(path) || path.startsWith('\\\\')) {
    return true
  }
  if (process.platform === 'darwin') {
    // Read once for a group of new/replaced roots, never on ordinary settled cycles.
    if (!mounts || Date.now() - mounts.at > 1_000) {
      mounts = {
        at: Date.now(),
        result: runProcess({ program: '/sbin/mount', timeoutMs: 2_000, maxOutputBytes: 256 * 1024 })
          .then(({ code, outputTruncated, stdout }) =>
            code !== 0 || outputTruncated
              ? undefined
              : stdout.split('\n').flatMap((line) => {
                  const match = / on (.+) \((?:nfs|smbfs|webdav|osxfuse|fusefs)[,)]/.exec(line)
                  return match ? [match[1]] : []
                })
          )
          .catch(() => undefined)
      }
    }
    const shared = await mounts.result
    return !shared || shared.some((root) => path === root || path.startsWith(`${root}/`))
  }
  if (process.platform === 'linux') {
    try {
      return [0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x65735546].includes(
        (await statfs(path)).type
      )
    } catch {
      return true
    }
  }
  return false
}
