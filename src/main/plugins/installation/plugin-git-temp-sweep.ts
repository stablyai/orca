import { lstat, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PLUGIN_GIT_CLONE_TEMP_PREFIX = 'orca-plugin-git-'
export const PLUGIN_GIT_LS_REMOTE_TEMP_PREFIX = 'orca-plugin-ls-remote-'
// Why: mkdtemp appends exactly six [A-Za-z0-9] characters, so nothing else in tmpdir() matches.
const PLUGIN_GIT_TEMP_NAME = /^orca-plugin-(?:git|ls-remote)-[A-Za-z0-9]{6}$/
// Why an hour: far past any live run (120 s per git call), so another Orca's fetch is never touched.
const PLUGIN_GIT_TEMP_MAX_AGE_MS = 60 * 60 * 1000
const SWEEP_STARTUP_DELAY_MS = 30_000

/** Removes plugin Git temp folders a killed or quit Orca left behind; best effort. */
export async function sweepStalePluginGitTempDirs(
  root = tmpdir(),
  now = Date.now()
): Promise<number> {
  let removed = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PLUGIN_GIT_TEMP_NAME.test(entry.name)) {
      continue
    }
    const path = join(root, entry.name)
    try {
      const stat = await lstat(path)
      if (stat.isDirectory() && now - stat.mtimeMs > PLUGIN_GIT_TEMP_MAX_AGE_MS) {
        await rm(path, { recursive: true, force: true })
        removed += 1
      }
    } catch (error) {
      console.warn(`[plugins] failed to remove stale plugin Git temp folder ${path}:`, error)
    }
  }
  return removed
}

/** A quit or crash mid-fetch skips a clone's own cleanup; this clears what earlier runs left. */
export function scheduleStalePluginGitTempSweep(): void {
  // Why delayed: deleting gigabytes must not compete with startup disk work.
  setTimeout(() => {
    void sweepStalePluginGitTempDirs().catch((error) =>
      console.warn('[plugins] failed to sweep stale plugin Git temp folders:', error)
    )
  }, SWEEP_STARTUP_DELAY_MS).unref?.()
}
