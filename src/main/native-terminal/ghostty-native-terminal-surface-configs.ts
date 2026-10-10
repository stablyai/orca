import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeTerminalAppearance } from '../../shared/native-terminal-appearance'
import type { GhosttyTerminalAddon } from './ghostty-native-terminal-addon'
import { buildGhosttyConfig } from './ghostty-native-terminal-config'

// Per-surface Ghostty config files, one per distinct config text: panes with the same
// appearance share a file, and a surface reloads only when its own text changes.
export type GhosttySurfaceConfigFiles = {
  // The file to load into this surface, or null when the surface already runs this text.
  fileFor: (surfaceId: number, text: string) => string | null
  forget: (surfaceId: number) => void
}

const FILE_PREFIX = 'surface-'

export function createGhosttySurfaceConfigFiles(dir: string): GhosttySurfaceConfigFiles {
  const applied = new Map<number, string>()
  const written = new Set<string>()
  let prepared = false

  const prepare = (): void => {
    if (prepared) {
      return
    }
    prepared = true
    mkdirSync(dir, { recursive: true })
    // Ghostty reads a file once at load, so earlier runs' files are dead weight.
    for (const name of readdirSync(dir)) {
      if (name.startsWith(FILE_PREFIX)) {
        rmSync(join(dir, name), { force: true })
      }
    }
  }

  return {
    fileFor: (surfaceId, text) => {
      if (applied.get(surfaceId) === text) {
        return null
      }
      prepare()
      const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
      const name = `${FILE_PREFIX}${hash}.conf`
      const path = join(dir, name)
      if (!written.has(name)) {
        writeFileSync(path, text)
        written.add(name)
      }
      applied.set(surfaceId, text)
      return path
    },
    forget: (surfaceId) => {
      applied.delete(surfaceId)
    }
  }
}

let files: GhosttySurfaceConfigFiles | null = null

// The app config holds defaults; each surface runs its pane's own (per-pane font zoom).
export function applyGhosttySurfaceConfig(
  native: GhosttyTerminalAddon,
  surfaceId: number,
  appearance: NativeTerminalAppearance,
  zoomFactor: number
): void {
  files ??= createGhosttySurfaceConfigFiles(join(app.getPath('userData'), 'native-terminal'))
  const path = files.fileFor(surfaceId, buildGhosttyConfig(appearance, zoomFactor))
  if (path) {
    native.updateSurfaceConfig(surfaceId, path)
  }
}

export function forgetGhosttySurfaceConfig(surfaceId: number): void {
  files?.forget(surfaceId)
}
