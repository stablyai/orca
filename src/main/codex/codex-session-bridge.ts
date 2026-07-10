import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import {
  listCodexSessionJsonlFiles,
  listCodexSessionJsonlFilesIncrementally
} from './codex-session-file-listing'
import type { CodexSessionBridgeIncrementalOptions } from './codex-session-file-listing'
import {
  clearLegacyCopiedSessionMarker,
  fileStatsMatchMarker,
  readLegacyCopiedSessionMarker,
  writeLegacyCopiedSessionMarker
} from './codex-session-copy-markers'
import {
  migrateLegacyCopiedSessionBridge,
  refreshCopiedSessionBridgeIfSourceGrew,
  tryCopySystemCodexSessionFile,
  tryHardlinkSystemCodexSessionFile
} from './codex-session-bridge-link'

export type { CodexSessionBridgeIncrementalOptions } from './codex-session-file-listing'

export type LegacyCopiedCodexSessionBridgeScanPreference = {
  sourcePath: string
  preferManagedCopy: boolean
  sourceSkipBytes: number | null
}

export type CodexSessionBridgeSummary = {
  scannedFiles: number
  linkedFiles: number
}

let backgroundSessionBridgeTask: Promise<void> | null = null

/**
 * Synchronously mirrors system session files into the managed runtime home.
 *
 * `sourceCodexHomePath` overrides the default ~/.codex history source for users
 * who run Codex with a custom CODEX_HOME; it only affects history discovery.
 */
export function syncSystemCodexSessionsIntoManagedHome(sourceCodexHomePath?: string): void {
  const systemSessionsRoot = join(sourceCodexHomePath || getSystemCodexHomePath(), 'sessions')
  if (!existsSync(systemSessionsRoot)) {
    return
  }

  const managedSessionsRoot = join(getOrcaManagedCodexHomePath(), 'sessions')
  for (const systemSessionFilePath of listCodexSessionJsonlFiles(systemSessionsRoot)) {
    bridgeSystemCodexSessionFile(systemSessionsRoot, managedSessionsRoot, systemSessionFilePath)
  }
}

/**
 * Starts a single background bridge task for historical system sessions.
 *
 * Concurrent callers share the same in-flight task so launch code can request
 * background bridging without starting duplicate directory walks.
 */
export function startSystemCodexSessionBridgeInBackground(
  options: CodexSessionBridgeIncrementalOptions = {},
  sourceCodexHomePath?: string
): Promise<void> {
  if (backgroundSessionBridgeTask) {
    return backgroundSessionBridgeTask
  }
  const task = syncSystemCodexSessionsIntoManagedHomeIncrementally(options, sourceCodexHomePath)
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

/**
 * Incrementally mirrors system session files into the managed runtime home.
 *
 * Returns scan/link counts for tests and diagnostics while keeping each file
 * bridge operation equivalent to the synchronous path.
 */
export async function syncSystemCodexSessionsIntoManagedHomeIncrementally(
  options: CodexSessionBridgeIncrementalOptions = {},
  sourceCodexHomePath?: string
): Promise<CodexSessionBridgeSummary> {
  const systemSessionsRoot = join(sourceCodexHomePath || getSystemCodexHomePath(), 'sessions')
  if (!existsSync(systemSessionsRoot)) {
    return { scannedFiles: 0, linkedFiles: 0 }
  }

  const managedSessionsRoot = join(getOrcaManagedCodexHomePath(), 'sessions')
  const summary: CodexSessionBridgeSummary = { scannedFiles: 0, linkedFiles: 0 }
  for await (const systemSessionFilePath of listCodexSessionJsonlFilesIncrementally(
    systemSessionsRoot,
    options
  )) {
    summary.scannedFiles += 1
    if (
      bridgeSystemCodexSessionFile(systemSessionsRoot, managedSessionsRoot, systemSessionFilePath)
    ) {
      summary.linkedFiles += 1
    }
  }
  return summary
}

/**
 * Bridges one system session file into the managed sessions tree.
 *
 * Existing managed files are migrated when possible; missing files are linked
 * and counted as newly available to the managed runtime home.
 */
function bridgeSystemCodexSessionFile(
  systemSessionsRoot: string,
  managedSessionsRoot: string,
  systemSessionFilePath: string
): boolean {
  const relativePath = relative(systemSessionsRoot, systemSessionFilePath)
  const managedSessionFilePath = join(managedSessionsRoot, relativePath)
  if (existsSync(managedSessionFilePath)) {
    if (
      replaceSymlinkSessionBridgeWithHardlink(
        systemSessionFilePath,
        managedSessionFilePath,
        relativePath
      )
    ) {
      return true
    }
    if (
      migrateLegacyCopiedSessionBridge(systemSessionFilePath, managedSessionFilePath, relativePath)
    ) {
      return true
    }
    // Why: hardlink failure leaves a copy. When the system session appends,
    // refresh the managed copy so Codex resume is not stuck on a truncated log.
    return refreshCopiedSessionBridgeIfSourceGrew(
      systemSessionFilePath,
      managedSessionFilePath,
      relativePath
    )
  }
  mkdirSync(dirname(managedSessionFilePath), { recursive: true })
  return linkSystemCodexSessionFile(systemSessionFilePath, managedSessionFilePath, relativePath)
}

/**
 * Links a source session file (hardlink preferred) or copy-syncs across volumes.
 */
function linkSystemCodexSessionFile(
  sourcePath: string,
  targetPath: string,
  relativePath: string
): boolean {
  if (tryHardlinkSystemCodexSessionFile(sourcePath, targetPath)) {
    clearLegacyCopiedSessionMarker(relativePath)
    return true
  }
  // Why: Codex resume ignores symlinks; cross-volume hardlink failure must
  // copy so the managed home still has a resume-visible regular file.
  return tryCopySystemCodexSessionFile(sourcePath, targetPath, relativePath)
}

/**
 * Replaces an older symlink bridge with a hardlink (or copy) so Codex resume
 * can see a regular file. Codex FS scans ignore symlinks.
 */
function replaceSymlinkSessionBridgeWithHardlink(
  sourcePath: string,
  targetPath: string,
  relativePath: string
): boolean {
  let replacementPath: string | null = null
  try {
    const targetStat = lstatSync(targetPath)
    if (!targetStat.isSymbolicLink()) {
      return false
    }
    const linkTarget = readlinkSync(targetPath)
    const absoluteLinkTarget = isAbsolute(linkTarget)
      ? linkTarget
      : join(dirname(targetPath), linkTarget)
    if (absoluteLinkTarget !== sourcePath) {
      return false
    }

    replacementPath = `${targetPath}.orca-link-${process.pid}-${Date.now()}`
    if (tryHardlinkSystemCodexSessionFile(sourcePath, replacementPath)) {
      rmSync(targetPath, { force: true })
      renameSync(replacementPath, targetPath)
      clearLegacyCopiedSessionMarker(relativePath)
      return true
    }
    if (tryCopySystemCodexSessionFile(sourcePath, replacementPath, relativePath)) {
      rmSync(targetPath, { force: true })
      renameSync(replacementPath, targetPath)
      // Marker was written against the temp path; rewrite for the final target.
      writeLegacyCopiedSessionMarker(relativePath, sourcePath, targetPath)
      return true
    }
    return false
  } catch (error) {
    console.warn(
      '[codex-session-bridge] Failed to replace symlinked Codex session bridge:',
      sourcePath,
      error
    )
    if (replacementPath) {
      rmSync(replacementPath, { force: true })
    }
  }
  return false
}

/**
 * Resolves how scanners should treat a legacy copied session bridge.
 *
 * The result keeps resume scans coherent until the copied bridge is migrated to
 * a hardlink.
 */
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
    // Why: legacy copied bridges share a prefix with the source. Scanner must
    // choose one full log until the bridge can be replaced with a real link.
    preferManagedCopy: !targetMatchesMarker || sourceMatchesMarker,
    sourceSkipBytes: !targetMatchesMarker && !sourceMatchesMarker ? marker.sourceSize : null
  }
}
