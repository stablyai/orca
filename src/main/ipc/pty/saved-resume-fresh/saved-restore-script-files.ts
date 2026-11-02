import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-environment'
import {
  getFishSavedRestoreScript,
  getPosixSavedRestoreScript,
  getPowerShellSavedRestoreScript
} from '../../../../shared/saved-restore-scripts'

let cached: { base: string; root: string } | null = null

/** The restore scripts' path without extension, content-addressed like Orca's shell wrappers so a
 *  running shell never sees another build's copy; null when they can't be written. */
export function ensureSavedRestoreScripts(): string | null {
  const scripts = {
    sh: getPosixSavedRestoreScript(),
    fish: getFishSavedRestoreScript(),
    ps1: getPowerShellSavedRestoreScript()
  }
  const digest = createHash('sha256').update(JSON.stringify(scripts)).digest('hex').slice(0, 16)
  const root = join(getAppEnvironment().getPath('userData'), 'shell-wrappers', 'saved-restore')
  const base = join(root, digest, 'restore')
  if (cached?.base === base && cached.root === root) {
    return base
  }
  try {
    mkdirSync(join(root, digest), { recursive: true, mode: 0o700 })
    for (const [extension, text] of Object.entries(scripts)) {
      const path = `${base}.${extension}`
      if (!existsSync(path)) {
        // Why rename: a shell reading the file never sees a partial write.
        const partial = `${path}.${process.pid}.tmp`
        writeFileSync(partial, text, { mode: 0o600 })
        renameSync(partial, path)
      }
    }
  } catch (error) {
    console.warn('[pty] could not write saved restore scripts', error)
    return null
  }
  cached = { base, root }
  return base
}
