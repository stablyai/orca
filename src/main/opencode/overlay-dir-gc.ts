import { lstat, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { yieldToEventLoop } from '../../shared/event-loop-yield'
import { isSafeDescendCandidate, safeRemoveOverlay } from '../pty/overlay-mirror'
import {
  OPENCODE_OVERLAY_MANIFEST_FILE,
  readOpenCodeOverlayManifest
} from './opencode-overlay-manifest'
import { inspectSourceDirectory, resolveOwnedOverlaySource } from './overlay-source-ownership'

export const OPENCODE_DIR_GC_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const OPENCODE_DIR_GC_MAX_REMOVALS_PER_SWEEP = 500

export type OpenCodeDirGcOptions = {
  overlayRoot: string
  pluginFileName: string
  referencedConfigDirs: ReadonlySet<string>
  readLivePtyIds: () => Promise<readonly string[] | null>
  now?: number
  minAgeMs?: number
  maxRemovals?: number
  removeTree?: (directory: string, root: string) => void
  yieldBetweenRemovals?: () => Promise<void>
}

export type OpenCodeDirGcResult = {
  scanned: number
  removed: number
  failed: number
  keptReferenced: number
  keptYoung: number
  keptSourcePresent: number
  keptUnverifiable: number
}

function normalized(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function isReferenced(directory: string, references: ReadonlySet<string>): boolean {
  const candidate = normalized(directory)
  for (const reference of references) {
    const value = normalized(reference)
    if (value === candidate || value.startsWith(candidate + sep)) {
      return true
    }
  }
  return false
}

async function oldEnough(directory: string, plugin: string, now: number, minAge: number) {
  let newest = 0
  for (const path of [
    directory,
    join(directory, OPENCODE_OVERLAY_MANIFEST_FILE),
    join(directory, 'plugins'),
    join(directory, 'plugins', plugin)
  ]) {
    try {
      const stats = await lstat(path)
      if (stats.isSymbolicLink()) {
        return false
      }
      newest = Math.max(newest, stats.mtimeMs)
    } catch {
      return false
    }
  }
  return newest > 0 && now - newest >= minAge
}

async function hasNoServiceConfig(directory: string): Promise<boolean> {
  try {
    const names = await readdir(directory)
    // Service registration lives in a different profile; config absence proves no PID verdict.
    return !names.some((name) => /^service(?:-[\w.-]+)?\.json$/i.test(name))
  } catch {
    return false
  }
}

export async function sweepOrphanedOpenCodeDirs(
  options: OpenCodeDirGcOptions
): Promise<OpenCodeDirGcResult> {
  const result: OpenCodeDirGcResult = {
    scanned: 0,
    removed: 0,
    failed: 0,
    keptReferenced: 0,
    keptYoung: 0,
    keptSourcePresent: 0,
    keptUnverifiable: 0
  }
  if ((await inspectSourceDirectory(options.overlayRoot)) !== 'present') {
    return result
  }
  const now = options.now ?? Date.now()
  const minAge = options.minAgeMs ?? OPENCODE_DIR_GC_MIN_AGE_MS
  const requestedLimit = options.maxRemovals ?? OPENCODE_DIR_GC_MAX_REMOVALS_PER_SWEEP
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(OPENCODE_DIR_GC_MAX_REMOVALS_PER_SWEEP, Math.max(0, Math.floor(requestedLimit)))
    : OPENCODE_DIR_GC_MAX_REMOVALS_PER_SWEEP
  const removeTree = options.removeTree ?? safeRemoveOverlay
  const yieldBetween = options.yieldBetweenRemovals ?? yieldToEventLoop
  let entries
  try {
    entries = await readdir(options.overlayRoot, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (result.removed + result.failed >= limit) {
      break
    }
    result.scanned += 1
    const directory = join(options.overlayRoot, entry.name)
    if (!/^[0-9a-f]{32}$/.test(entry.name) || !isSafeDescendCandidate(entry)) {
      result.keptUnverifiable += 1
      continue
    }
    if (isReferenced(directory, options.referencedConfigDirs)) {
      result.keptReferenced += 1
      continue
    }
    try {
      const manifestStats = await lstat(join(directory, OPENCODE_OVERLAY_MANIFEST_FILE))
      if (
        !manifestStats.isFile() ||
        manifestStats.isSymbolicLink() ||
        manifestStats.size > 64 * 1024
      ) {
        result.keptUnverifiable += 1
        continue
      }
      const source = await resolveOwnedOverlaySource(
        directory,
        readOpenCodeOverlayManifest(directory)
      )
      if (!source) {
        result.keptUnverifiable += 1
        continue
      }
      const presence = await inspectSourceDirectory(source)
      if (presence === 'present') {
        result.keptSourcePresent += 1
        continue
      }
      if (presence !== 'absent' || !(await hasNoServiceConfig(directory))) {
        result.keptUnverifiable += 1
        continue
      }
      if (!(await oldEnough(directory, options.pluginFileName, now, minAge))) {
        result.keptYoung += 1
        continue
      }
      // A restarted app's empty cache cannot establish surviving daemon terminals are gone.
      const liveIds = await options.readLivePtyIds().catch(() => null)
      if (liveIds === null || liveIds.length !== 0) {
        result.keptUnverifiable += 1
        continue
      }
      if (
        isReferenced(directory, options.referencedConfigDirs) ||
        isReferenced(source, options.referencedConfigDirs)
      ) {
        result.keptReferenced += 1
        continue
      }
      if (
        (await inspectSourceDirectory(source)) !== 'absent' ||
        (await inspectSourceDirectory(options.overlayRoot)) !== 'present' ||
        !(await hasNoServiceConfig(directory))
      ) {
        result.keptUnverifiable += 1
        continue
      }
      if (
        isReferenced(directory, options.referencedConfigDirs) ||
        isReferenced(source, options.referencedConfigDirs)
      ) {
        result.keptReferenced += 1
        continue
      }
      try {
        removeTree(directory, options.overlayRoot)
        try {
          await lstat(directory)
          result.failed += 1
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            result.removed += 1
          } else {
            result.failed += 1
          }
        }
      } catch {
        result.failed += 1
      }
      await yieldBetween()
    } catch {
      result.keptUnverifiable += 1
    }
  }
  return result
}
