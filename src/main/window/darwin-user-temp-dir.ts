import { tmpdir } from 'node:os'
import { isAbsolute } from 'node:path'
import { runProcess } from '@orca/process-host'

const GETCONF_TIMEOUT_MS = 5_000

let resolved: Promise<string> | null = null

/**
 * The per-user temp dir macOS drag providers write to. `os.tmpdir()` follows
 * `$TMPDIR`, so a custom one would hide every `TemporaryItems/NSIRD_*` drop.
 */
export function getDarwinUserTempDir(
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  if (platform !== 'darwin') {
    return Promise.resolve(tmpdir())
  }
  resolved ??= readDarwinUserTempDir()
  return resolved
}

async function readDarwinUserTempDir(): Promise<string> {
  try {
    const result = await runProcess({
      program: '/usr/bin/getconf',
      args: ['DARWIN_USER_TEMP_DIR'],
      timeoutMs: GETCONF_TIMEOUT_MS
    })
    const dir = result.stdout.trim()
    if (result.code === 0 && isAbsolute(dir)) {
      return dir
    }
  } catch {
    // Fall through: `os.tmpdir()` is right whenever `$TMPDIR` is not customised.
  }
  // Why: don't pin a transient failure for the app's lifetime.
  resolved = null
  return tmpdir()
}
