import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import {
  listCodexSessionJsonlFiles,
  listCodexSessionJsonlFilesIncrementally
} from './codex-session-file-listing'
import type { CodexSessionBridgeIncrementalOptions } from './codex-session-file-listing'

export type { CodexSessionBridgeIncrementalOptions } from './codex-session-file-listing'

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

export type CodexSessionBridgeSummary = {
  scannedFiles: number
  linkedFiles: number
}

let backgroundSessionBridgeTask: Promise<void> | null = null

/**
 * Synchronously mirrors system session files into the managed runtime home.
 */
export function syncSystemCodexSessionsIntoManagedHome(): void {
  const systemSessionsRoot = join(getSystemCodexHomePath(), 'sessions')
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
  options: CodexSessionBridgeIncrementalOptions = {}
): Promise<void> {
  if (backgroundSessionBridgeTask) {
    return backgroundSessionBridgeTask
  }
  const task = syncSystemCodexSessionsIntoManagedHomeIncrementally(options)
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
  options: CodexSessionBridgeIncrementalOptions = {}
): Promise<CodexSessionBridgeSummary> {
  const systemSessionsRoot = join(getSystemCodexHomePath(), 'sessions')
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
    migrateLegacyCopiedSessionBridge(systemSessionFilePath, managedSessionFilePath, relativePath)
    return false
  }
  mkdirSync(dirname(managedSessionFilePath), { recursive: true })
  return linkSystemCodexSessionFile(systemSessionFilePath, managedSessionFilePath, relativePath)
}

/**
 * Links a source session file and clears any stale copied-session marker.
 */
function linkSystemCodexSessionFile(
  sourcePath: string,
  targetPath: string,
  relativePath: string
): boolean {
  const linked = tryLinkSystemCodexSessionFile(sourcePath, targetPath)
  if (linked) {
    clearLegacyCopiedSessionMarker(relativePath)
  }
  return linked
}

/**
 * Attempts to link a session file with hardlink first and symlink fallback.
 */
function tryLinkSystemCodexSessionFile(sourcePath: string, targetPath: string): boolean {
  if (tryHardlinkSystemCodexSessionFile(sourcePath, targetPath)) {
    return true
  }
  try {
    // Why fallback: hardlinks keep sessions visible to Codex resume, but can
    // fail across volumes. A symlink is still better than a diverging copy.
    symlinkSync(sourcePath, targetPath, process.platform === 'win32' ? 'file' : undefined)
    return true
  } catch (error) {
    console.warn('[codex-session-bridge] Failed to link system Codex session:', sourcePath, error)
  }
  return false
}

/**
 * Attempts a hardlink so resume sees one physical JSONL session log.
 */
function tryHardlinkSystemCodexSessionFile(sourcePath: string, targetPath: string): boolean {
  try {
    // Why: Codex resume ignores symlinked JSONL sessions, while a hardlink
    // preserves one physical log without copy divergence.
    linkSync(sourcePath, targetPath)
    return true
  } catch {
    return false
  }
}

/**
 * Replaces an older symlink bridge with a hardlink when the target still points
 * at the expected source session.
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
    if (!tryHardlinkSystemCodexSessionFile(sourcePath, replacementPath)) {
      return false
    }
    rmSync(targetPath, { force: true })
    renameSync(replacementPath, targetPath)
    clearLegacyCopiedSessionMarker(relativePath)
    return true
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
 * Migrates a legacy copied bridge to a linked bridge when the copied file still
 * matches its marker.
 */
function migrateLegacyCopiedSessionBridge(
  sourcePath: string,
  targetPath: string,
  relativePath: string
): void {
  const marker = readLegacyCopiedSessionMarker(relativePath)
  if (!marker || marker.sourcePath !== sourcePath) {
    return
  }
  let replacementPath: string | null = null
  try {
    const targetStat = lstatSync(targetPath)
    if (targetStat.isSymbolicLink()) {
      clearLegacyCopiedSessionMarker(relativePath)
      return
    }
    if (!fileStatsMatchMarker(targetStat, marker, 'target')) {
      return
    }
    replacementPath = `${targetPath}.orca-link-${process.pid}-${Date.now()}`
    if (!tryLinkSystemCodexSessionFile(sourcePath, replacementPath)) {
      return
    }
    rmSync(targetPath, { force: true })
    renameSync(replacementPath, targetPath)
    clearLegacyCopiedSessionMarker(relativePath)
  } catch (error) {
    console.warn(
      '[codex-session-bridge] Failed to migrate copied system Codex session:',
      sourcePath,
      error
    )
    if (replacementPath) {
      rmSync(replacementPath, { force: true })
    }
  }
}

/**
 * Resolves how scanners should treat a legacy copied session bridge.
 *
 * The result keeps resume scans coherent until the copied bridge is migrated to
 * a hardlink or symlink.
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

/**
 * Returns the marker path for a legacy copied session bridge.
 */
function getLegacySessionCopyMarkerPath(relativePath: string): string {
  return join(getOrcaManagedCodexHomePath(), '.orca-session-copies', `${relativePath}.json`)
}

/**
 * Reads and validates the marker for a legacy copied session bridge.
 */
function readLegacyCopiedSessionMarker(relativePath: string): LegacyCopiedSessionMarker | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(getLegacySessionCopyMarkerPath(relativePath), 'utf-8')
    )
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

/**
 * Checks whether source or target file stats still match a legacy bridge marker.
 */
function fileStatsMatchMarker(
  stat: { size: number; mtimeMs: number },
  marker: LegacyCopiedSessionMarker,
  kind: 'source' | 'target'
): boolean {
  const expectedSize = kind === 'source' ? marker.sourceSize : marker.targetSize
  const expectedMtimeMs = kind === 'source' ? marker.sourceMtimeMs : marker.targetMtimeMs
  return stat.size === expectedSize && stat.mtimeMs === expectedMtimeMs
}

/**
 * Removes the marker after a copied session bridge has been migrated or retired.
 */
function clearLegacyCopiedSessionMarker(relativePath: string): void {
  rmSync(getLegacySessionCopyMarkerPath(relativePath), { force: true })
}
