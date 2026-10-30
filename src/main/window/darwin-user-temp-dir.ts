import { tmpdir } from 'node:os'
import { isAbsolute } from 'node:path'
import { runProcess } from '@orca/process-host'

const GETCONF_TIMEOUT_MS = 5_000

let resolved: Promise<string> | null = null

/** Resolve the real macOS per-user temp root: custom TMPDIR makes os.tmpdir miss drag-provider files. */
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
    // os.tmpdir is correct when TMPDIR is unmodified.
  }
  // Do not cache transient resolution failures for the app lifetime.
  resolved = null
  return tmpdir()
}
