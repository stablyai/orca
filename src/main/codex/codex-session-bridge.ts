import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import {
  listCodexSessionJsonlFiles,
  listCodexSessionJsonlFilesIncrementally
} from './codex-session-file-listing'
import type { CodexSessionBridgeIncrementalOptions } from './codex-session-file-listing'
import { exportManagedCodexSessionToSystemHistory } from './codex-session-managed-export'
import {
  clearLegacyCopiedSessionMarker,
  migrateLegacyCopiedSessionBridge
} from './codex-session-legacy-copy'

export { exportManagedCodexSessionToSystemHistory } from './codex-session-managed-export'
export { getLegacyCopiedCodexSessionBridgeScanPreference } from './codex-session-legacy-copy'
export type { LegacyCopiedCodexSessionBridgeScanPreference } from './codex-session-legacy-copy'

export type { CodexSessionBridgeIncrementalOptions } from './codex-session-file-listing'

export type CodexSessionBridgeSummary = {
  scannedFiles: number
  linkedFiles: number
}

let backgroundSessionBridgeTask: Promise<void> | null = null

/**
 * Synchronously reconciles system and managed Codex session histories.
 *
 * `sourceCodexHomePath` overrides the default ~/.codex history source for users
 * who run Codex with a custom CODEX_HOME; it only affects history discovery.
 */
export function syncSystemCodexSessionsIntoManagedHome(sourceCodexHomePath?: string): void {
  const systemCodexHomePath = sourceCodexHomePath || getSystemCodexHomePath()
  const managedSessionsRoot = join(getOrcaManagedCodexHomePath(), 'sessions')
  if (existsSync(managedSessionsRoot)) {
    for (const managedSessionFilePath of listCodexSessionJsonlFiles(managedSessionsRoot)) {
      exportManagedCodexSessionToSystemHistory(managedSessionFilePath, systemCodexHomePath)
    }
  }

  const systemSessionsRoot = join(systemCodexHomePath, 'sessions')
  if (!existsSync(systemSessionsRoot)) {
    return
  }
  for (const systemSessionFilePath of listCodexSessionJsonlFiles(systemSessionsRoot)) {
    bridgeSystemCodexSessionFile(systemSessionsRoot, managedSessionsRoot, systemSessionFilePath)
  }
}

/**
 * Starts one background task to reconcile historical sessions between homes.
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
 * Incrementally reconciles system and managed Codex session histories.
 *
 * Returns scan/link counts for tests and diagnostics while keeping each file
 * bridge operation equivalent to the synchronous path.
 */
export async function syncSystemCodexSessionsIntoManagedHomeIncrementally(
  options: CodexSessionBridgeIncrementalOptions = {},
  sourceCodexHomePath?: string
): Promise<CodexSessionBridgeSummary> {
  const systemCodexHomePath = sourceCodexHomePath || getSystemCodexHomePath()
  const systemSessionsRoot = join(systemCodexHomePath, 'sessions')
  const managedSessionsRoot = join(getOrcaManagedCodexHomePath(), 'sessions')
  const summary: CodexSessionBridgeSummary = { scannedFiles: 0, linkedFiles: 0 }
  if (existsSync(managedSessionsRoot)) {
    for await (const managedSessionFilePath of listCodexSessionJsonlFilesIncrementally(
      managedSessionsRoot,
      options
    )) {
      summary.scannedFiles += 1
      if (
        exportManagedCodexSessionToSystemHistory(managedSessionFilePath, systemCodexHomePath) ===
        'linked'
      ) {
        summary.linkedFiles += 1
      }
    }
  }
  if (!existsSync(systemSessionsRoot)) {
    return summary
  }
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
    migrateLegacyCopiedSessionBridge(
      systemSessionFilePath,
      managedSessionFilePath,
      relativePath,
      tryLinkSystemCodexSessionFile
    )
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
