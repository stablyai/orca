import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function createWatcherCanaryDirectory(): string | null {
  try {
    return mkdtempSync(join(tmpdir(), 'orca-watcher-canary-'))
  } catch (error) {
    // Why: the canary is diagnostic only; read-only temp storage must not
    // disable the crash-isolated watcher itself.
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
