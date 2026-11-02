import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { getSavedRestoreActionFiles } from '../../../../shared/saved-restore-dispatch'
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

// A launch reads its action within the receipt's lifetime; anything older is a crash leftover.
const STALE_ACTION_MS = 60 * 60 * 1000

function actionRoot(): string {
  return join(getAppEnvironment().getPath('userData'), 'shell-wrappers', 'saved-restore', 'launch')
}

/** This launch's private action data, readable only by the user; its path without extension. */
export function writeSavedRestoreAction(
  data: Parameters<typeof getSavedRestoreActionFiles>[0]
): string | null {
  const root = actionRoot()
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      if (Date.now() - statSync(dir).mtimeMs > STALE_ACTION_MS) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    const dir = join(root, randomBytes(8).toString('hex'))
    mkdirSync(dir, { mode: 0o700 })
    for (const [extension, text] of Object.entries(getSavedRestoreActionFiles(data))) {
      writeFileSync(join(dir, `action.${extension}`), text, { mode: 0o600 })
    }
    return join(dir, 'action')
  } catch (error) {
    console.warn('[pty] could not write a saved restore action', error)
    return null
  }
}

export function discardSavedRestoreAction(action: string): void {
  // Only a directory this module created: the root's launch folder for one action.
  const dir = join(action, '..')
  if (join(dir, '..') === actionRoot()) {
    rmSync(dir, { recursive: true, force: true })
  }
}
