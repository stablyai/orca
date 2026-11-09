import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function createWatcherCanaryDirectory(): string | null {
  try {
    return mkdtempSync(join(tmpdir(), 'orca-watcher-canary-'))
  } catch (error) {
    // Read-only temp storage must not disable the watcher; the canary is diagnostic.
    console.warn('[parcel-watcher-process] canary directory unavailable:', error)
    return null
  }
}

export function removeWatcherCanaryDirectory(canaryDir: string | null): null {
  if (!canaryDir) {
    return null
  }
  try {
    rmSync(canaryDir, { recursive: true, force: true })
  } catch {
    // Canary cleanup is best-effort; watcher lifecycle must still complete.
  }
  return null
}
