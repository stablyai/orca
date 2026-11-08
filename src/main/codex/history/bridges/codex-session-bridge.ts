import { lstatSync, readFileSync } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { link, lstat, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { isDefinitiveAbsence } from '../../../../shared/definitive-filesystem-absence'
import {
  getOrcaManagedCodexHomePath,
  getSystemCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import { isUnsupportedHardlinkError } from '../rollouts/codex-rollout-hardlink'
import { linkMissingCodexSessionRollouts } from '../rollouts/codex-session-link'

type LegacyCopiedSessionMarker = {
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  targetSize: number
  targetMtimeMs: number
}

export type LegacyCopiedCodexSessionBridgeScanPreference = {
  sourcePath: string
  preferManagedCopy: boolean
  sourceSkipBytes: number | null
}

const LEGACY_COPY_MARKER_DIR = '.orca-session-copies'
const PREFIX_COMPARE_CHUNK_BYTES = 1024 * 1024

let backgroundSessionBridgeTask: Promise<void> | null = null
// Markers are the migration's durable state; diverged copies keep theirs, so walk once per source per run.
const legacyCopyMigratedSources = new Set<string>()

/** Custom CODEX_HOME changes history discovery only. */
export function startSystemCodexSessionBridgeInBackground(
  sourceCodexHomePath?: string
): Promise<void> {
  if (backgroundSessionBridgeTask) {
    return backgroundSessionBridgeTask
  }
  const managedHomePath = getOrcaManagedCodexHomePath()
  const sourceHomePath = sourceCodexHomePath || getSystemCodexHomePath()
  const sourceKey = normalizeRuntimePathForComparison(sourceHomePath)
  const migrateLegacyCopies = !legacyCopyMigratedSources.has(sourceKey)
  legacyCopyMigratedSources.add(sourceKey)
  const task = (async () => {
    if (migrateLegacyCopies) {
      await migrateLegacyCopiedCodexSessions(managedHomePath, sourceHomePath)
    }
    await linkMissingCodexSessionRollouts({
      sourceCodexHomePaths: [sourceHomePath],
      targetCodexHomePath: managedHomePath
    })
  })()
    .catch((error: unknown) => {
      console.warn('[codex-session-bridge] Background session bridge failed:', error)
    })
    .then(() => undefined)
  backgroundSessionBridgeTask = task
  void task.finally(() => {
    if (backgroundSessionBridgeTask === task) {
      backgroundSessionBridgeTask = null
    }
  })
  return task
}

/** Keep usage scans coherent for copies made before session bridges used links. */
export function getLegacyCopiedCodexSessionBridgeScanPreference(
  sessionFilePath: string
): LegacyCopiedCodexSessionBridgeScanPreference | null {
  const managedSessionsRoot = join(getOrcaManagedCodexHomePath(), 'sessions')
  const relativePath = relative(managedSessionsRoot, sessionFilePath)
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null
  }
  const marker = readLegacyCopiedSessionMarker(relativePath)
  if (!marker) {
    return null
  }

  let targetMatchesMarker = false
  let sourceMatchesMarker = false
  try {
    targetMatchesMarker = fileStatsMatchMarker(lstatSync(sessionFilePath), marker, 'target')
  } catch {}
  try {
    sourceMatchesMarker = fileStatsMatchMarker(lstatSync(marker.sourcePath), marker, 'source')
  } catch {}

  return {
    sourcePath: marker.sourcePath,
    // Legacy copies share a prefix with their source; scan one full log until they become linked.
    preferManagedCopy: !targetMatchesMarker || sourceMatchesMarker,
    sourceSkipBytes: !targetMatchesMarker && !sourceMatchesMarker ? marker.sourceSize : null
  }
}

/**
 * Replaces unchanged pre-link session copies in the shared runtime home with hardlinks to their
 * source, so resume reads one growing log. Restart-safe: a marker is cleared only after the swap.
 */
export async function migrateLegacyCopiedCodexSessions(
  managedHomePath: string,
  sourceCodexHomePath: string
): Promise<number> {
  const markerRoot = join(managedHomePath, LEGACY_COPY_MARKER_DIR)
  let migrated = 0
  for await (const markerPath of listLegacyCopyMarkers(markerRoot)) {
    const relativePath = relative(markerRoot, markerPath).slice(0, -'.json'.length)
    if (
      await migrateLegacyCopiedSession(
        markerPath,
        join(sourceCodexHomePath, 'sessions', relativePath),
        join(managedHomePath, 'sessions', relativePath)
      )
    ) {
      migrated += 1
    }
  }
  return migrated
}

async function* listLegacyCopyMarkers(directory: string): AsyncGenerator<string> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      yield* listLegacyCopyMarkers(entryPath)
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      yield entryPath
    }
  }
}

async function migrateLegacyCopiedSession(
  markerPath: string,
  sourcePath: string,
  targetPath: string
): Promise<boolean> {
  let marker: LegacyCopiedSessionMarker | null
  try {
    marker = parseLegacyCopiedSessionMarker(await readFile(markerPath, 'utf-8'))
  } catch {
    return false
  }
  // A marker from a previously configured source stays until that source is selected again.
  if (
    !marker ||
    normalizeRuntimePathForComparison(marker.sourcePath) !==
      normalizeRuntimePathForComparison(sourcePath)
  ) {
    return false
  }
  let targetStat: Stats
  try {
    targetStat = await lstat(targetPath)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      // The copy is gone; the session link pass links the source instead.
      await rm(markerPath, { force: true })
    }
    return false
  }
  if (targetStat.isSymbolicLink()) {
    // The session link pass owns symlinks; the copy this marker described is gone.
    await rm(markerPath, { force: true })
    return false
  }
  const replacementPath = `${targetPath}.orca-link-${process.pid}`
  try {
    if (!fileStatsMatchMarker(targetStat, marker, 'target')) {
      // Codex appended to the copy, so it is the only full log; usage scans keep using the marker.
      return false
    }
    // Only a source that still begins with the whole copy can replace it without losing turns.
    if (!(await startsWithFileContents(sourcePath, targetPath, targetStat.size))) {
      return false
    }
    await rm(replacementPath, { force: true })
    await link(sourcePath, replacementPath)
    await rename(replacementPath, targetPath)
    await rm(markerPath, { force: true })
    return true
  } catch (error) {
    await rm(replacementPath, { force: true }).catch(() => {})
    if (!isUnsupportedHardlinkError(error)) {
      console.warn(
        '[codex-session-bridge] Failed to migrate copied Codex session:',
        targetPath,
        error
      )
    }
    // A cross-volume copy stays a copy: a symlink would be ignored by resume.
    return false
  }
}

async function startsWithFileContents(
  filePath: string,
  prefixPath: string,
  prefixSize: number
): Promise<boolean> {
  const fileStat = await lstat(filePath)
  if (!fileStat.isFile() || fileStat.size < prefixSize) {
    return false
  }
  const file = await open(filePath, 'r')
  const prefix = await open(prefixPath, 'r').catch(async (error: unknown) => {
    await file.close()
    throw error
  })
  try {
    const fileChunk = Buffer.alloc(PREFIX_COMPARE_CHUNK_BYTES)
    const prefixChunk = Buffer.alloc(PREFIX_COMPARE_CHUNK_BYTES)
    for (let offset = 0; offset < prefixSize; offset += PREFIX_COMPARE_CHUNK_BYTES) {
      const length = Math.min(PREFIX_COMPARE_CHUNK_BYTES, prefixSize - offset)
      const [fileRead, prefixRead] = await Promise.all([
        file.read(fileChunk, 0, length, offset),
        prefix.read(prefixChunk, 0, length, offset)
      ])
      if (
        fileRead.bytesRead !== length ||
        prefixRead.bytesRead !== length ||
        !fileChunk.subarray(0, length).equals(prefixChunk.subarray(0, length))
      ) {
        return false
      }
    }
    return true
  } finally {
    await Promise.all([file.close(), prefix.close()])
  }
}

function getLegacySessionCopyMarkerPath(relativePath: string): string {
  return join(getOrcaManagedCodexHomePath(), LEGACY_COPY_MARKER_DIR, `${relativePath}.json`)
}

function readLegacyCopiedSessionMarker(relativePath: string): LegacyCopiedSessionMarker | null {
  try {
    return parseLegacyCopiedSessionMarker(
      readFileSync(getLegacySessionCopyMarkerPath(relativePath), 'utf-8')
    )
  } catch {
    return null
  }
}

function parseLegacyCopiedSessionMarker(text: string): LegacyCopiedSessionMarker | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const marker = parsed as Record<string, unknown>
    if (
      typeof marker.sourcePath !== 'string' ||
      typeof marker.sourceSize !== 'number' ||
      typeof marker.sourceMtimeMs !== 'number' ||
      typeof marker.targetSize !== 'number' ||
      typeof marker.targetMtimeMs !== 'number'
    ) {
      return null
    }
    return marker as LegacyCopiedSessionMarker
  } catch {
    return null
  }
}

function fileStatsMatchMarker(
  stat: { size: number; mtimeMs: number },
  marker: LegacyCopiedSessionMarker,
  kind: 'source' | 'target'
): boolean {
  const expectedSize = kind === 'source' ? marker.sourceSize : marker.targetSize
  const expectedMtimeMs = kind === 'source' ? marker.sourceMtimeMs : marker.targetMtimeMs
  return stat.size === expectedSize && stat.mtimeMs === expectedMtimeMs
}
