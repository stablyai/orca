import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import { promisify } from 'node:util'
import { isWslUncPath } from '../../shared/wsl-paths'

const run = promisify(execFile)
let mounts: { at: number; result: Promise<string[]> } | undefined

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
        result: run('/sbin/mount', [], { timeout: 2_000, maxBuffer: 256 * 1024 })
          .then(({ stdout }) =>
            stdout.split('\n').flatMap((line) => {
              const match = / on (.+) \((?:nfs|smbfs|webdav|osxfuse|fusefs)[,)]/.exec(line)
              return match ? [match[1]] : []
            })
          )
          .catch(() => [])
      }
    }
    return (await mounts.result).some((root) => path === root || path.startsWith(`${root}/`))
  }
  if (process.platform === 'linux') {
    try {
      return [0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x65735546].includes(
        (await statfs(path)).type
      )
    } catch {
      return false
    }
  }
  return false
}
