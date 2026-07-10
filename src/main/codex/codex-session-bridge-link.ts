import { copyFileSync, linkSync, lstatSync, renameSync, rmSync } from 'node:fs'
import {
  clearLegacyCopiedSessionMarker,
  fileStatsMatchMarker,
  readLegacyCopiedSessionMarker,
  writeLegacyCopiedSessionMarker
} from './codex-session-copy-markers'

/**
 * Attempts a hardlink so resume sees one physical JSONL session log.
 */
export function tryHardlinkSystemCodexSessionFile(sourcePath: string, targetPath: string): boolean {
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
 * Copies a session file and records a marker so later scans can keep the copy
 * coherent until a hardlink migration succeeds.
 */
export function tryCopySystemCodexSessionFile(
  sourcePath: string,
  targetPath: string,
  relativePath: string
): boolean {
  try {
    copyFileSync(sourcePath, targetPath)
    writeLegacyCopiedSessionMarker(relativePath, sourcePath, targetPath)
    return true
  } catch (error) {
    console.warn('[codex-session-bridge] Failed to copy system Codex session:', sourcePath, error)
    return false
  }
}

/**
 * Migrates a legacy copied bridge to a hardlink when the copied file still
 * matches its marker. Leaves the copy in place when hardlink is unavailable.
 * Returns true when the target is now a hardlink.
 */
export function migrateLegacyCopiedSessionBridge(
  sourcePath: string,
  targetPath: string,
  relativePath: string
): boolean {
  const marker = readLegacyCopiedSessionMarker(relativePath)
  if (!marker || marker.sourcePath !== sourcePath) {
    return false
  }
  let replacementPath: string | null = null
  try {
    const targetStat = lstatSync(targetPath)
    if (targetStat.isSymbolicLink()) {
      clearLegacyCopiedSessionMarker(relativePath)
      return false
    }
    if (!fileStatsMatchMarker(targetStat, marker, 'target')) {
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
      '[codex-session-bridge] Failed to migrate copied system Codex session:',
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
 * Re-copies a managed session when the system source has grown past the
 * copy-sync marker. Prefer hardlink if it becomes available on a later pass.
 */
export function refreshCopiedSessionBridgeIfSourceGrew(
  sourcePath: string,
  targetPath: string,
  relativePath: string
): boolean {
  const marker = readLegacyCopiedSessionMarker(relativePath)
  if (!marker || marker.sourcePath !== sourcePath) {
    return false
  }
  try {
    const targetStat = lstatSync(targetPath)
    if (targetStat.isSymbolicLink() || targetStat.isDirectory()) {
      return false
    }
    const sourceStat = lstatSync(sourcePath)
    // Source still matches marker → copy is current; nothing to refresh.
    if (fileStatsMatchMarker(sourceStat, marker, 'source')) {
      return false
    }
    // Prefer hardlink when the filesystem now allows it (same volume later).
    const replacementPath = `${targetPath}.orca-link-${process.pid}-${Date.now()}`
    if (tryHardlinkSystemCodexSessionFile(sourcePath, replacementPath)) {
      rmSync(targetPath, { force: true })
      renameSync(replacementPath, targetPath)
      clearLegacyCopiedSessionMarker(relativePath)
      return true
    }
    if (tryCopySystemCodexSessionFile(sourcePath, replacementPath, relativePath)) {
      rmSync(targetPath, { force: true })
      renameSync(replacementPath, targetPath)
      writeLegacyCopiedSessionMarker(relativePath, sourcePath, targetPath)
      return true
    }
    rmSync(replacementPath, { force: true })
  } catch (error) {
    console.warn(
      '[codex-session-bridge] Failed to refresh copied system Codex session:',
      sourcePath,
      error
    )
  }
  return false
}
