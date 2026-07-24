import { cpSync, lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { ORCA_PI_AGENT_STATUS_EXTENSION_FILE } from './agent-status-extension-source'
import { ORCA_PI_PREFILL_EXTENSION_FILE } from './prefill-extension-source'
import { ORCA_PI_EXTENSION_FILE } from './titlebar-extension-source'
import { isSafeDescendCandidate } from '../pty/overlay-mirror'

const LEGACY_PI_OVERLAY_MANIFEST_FILE = '.orca-pi-overlay-manifest.json'
const LEGACY_OMP_OVERLAY_MIGRATION_MARKER_FILE = '.orca-omp-overlay-migration-complete'
const PI_AGENT_SETTINGS_FILE = 'settings.json'
const SQLITE_DATABASE_EXTENSION = '.db'
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const
const MANAGED_EXTENSION_FILES = new Set([
  ORCA_PI_EXTENSION_FILE,
  ORCA_PI_PREFILL_EXTENSION_FILE,
  ORCA_PI_AGENT_STATUS_EXTENSION_FILE
])

type DeferredSidecar = {
  baseTargetPath: string
  entry: Dirent
  nextSegments: string[]
}

function getPathStats(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

function getSqliteSidecarBaseName(name: string): string | undefined {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    if (!name.endsWith(suffix)) {
      continue
    }
    const baseName = name.slice(0, -suffix.length)
    return baseName.endsWith(SQLITE_DATABASE_EXTENSION) ? baseName : undefined
  }
  return undefined
}

function shouldSkipLegacyOverlayEntry(pathSegments: string[]): boolean {
  const name = pathSegments.at(-1)
  if (!name) {
    return true
  }
  if (pathSegments.length === 1) {
    return (
      name === LEGACY_PI_OVERLAY_MANIFEST_FILE ||
      name === LEGACY_OMP_OVERLAY_MIGRATION_MARKER_FILE ||
      name === PI_AGENT_SETTINGS_FILE
    )
  }
  return (
    pathSegments.length === 2 &&
    pathSegments[0] === 'extensions' &&
    MANAGED_EXTENSION_FILES.has(name)
  )
}

function copyLegacyFile(
  overlayPath: string,
  targetPath: string,
  copiedFilePaths: Set<string>
): boolean {
  if (getPathStats(targetPath)) {
    return true
  }
  try {
    mkdirSync(dirname(targetPath), { recursive: true })
    cpSync(overlayPath, targetPath, {
      errorOnExist: true,
      force: false,
      preserveTimestamps: true
    })
    copiedFilePaths.add(targetPath)
    return true
  } catch {
    return false
  }
}

function removeCopiedFiles(paths: string[], copiedFilePaths: Set<string>): void {
  for (const path of paths) {
    if (!copiedFilePaths.delete(path)) {
      continue
    }
    try {
      unlinkSync(path)
    } catch {
      // Best-effort: withholding the marker lets later spawns retry.
    }
  }
}

function copyDeferredSidecars(
  overlayDir: string,
  sourceAgentDir: string,
  copiedFilePaths: Set<string>,
  deferredSidecars: DeferredSidecar[]
): boolean {
  let completed = true
  const copiedSidecarsByBase = new Map<string, string[]>()
  for (const { baseTargetPath, entry, nextSegments } of deferredSidecars) {
    if (!copiedFilePaths.has(baseTargetPath)) {
      continue
    }

    const overlayPath = join(overlayDir, entry.name)
    const targetPath = join(sourceAgentDir, ...nextSegments)
    const stats = getPathStats(overlayPath)
    if (!stats) {
      removeCopiedFiles(
        [baseTargetPath, ...(copiedSidecarsByBase.get(baseTargetPath) ?? [])],
        copiedFilePaths
      )
      completed = false
      continue
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      continue
    }
    const wasCopied = copiedFilePaths.has(targetPath)
    if (!copyLegacyFile(overlayPath, targetPath, copiedFilePaths)) {
      removeCopiedFiles(
        [baseTargetPath, ...(copiedSidecarsByBase.get(baseTargetPath) ?? [])],
        copiedFilePaths
      )
      completed = false
      continue
    }
    if (!wasCopied && copiedFilePaths.has(targetPath)) {
      copiedSidecarsByBase.set(baseTargetPath, [
        ...(copiedSidecarsByBase.get(baseTargetPath) ?? []),
        targetPath
      ])
    }
  }
  return completed
}

function copyMissingLegacyOmpOverlayEntries(
  overlayDir: string,
  sourceAgentDir: string,
  pathSegments: string[] = [],
  copiedFilePaths: Set<string> = new Set()
): boolean {
  let completed = true
  let entries: Dirent[]
  try {
    entries = readdirSync(overlayDir, { withFileTypes: true })
  } catch {
    return false
  }

  const deferredSidecars: DeferredSidecar[] = []
  for (const entry of entries) {
    const nextSegments = [...pathSegments, entry.name]
    if (shouldSkipLegacyOverlayEntry(nextSegments)) {
      continue
    }

    const sidecarBaseName = getSqliteSidecarBaseName(entry.name)
    if (sidecarBaseName) {
      deferredSidecars.push({
        baseTargetPath: join(sourceAgentDir, ...pathSegments, sidecarBaseName),
        entry,
        nextSegments
      })
      continue
    }

    const overlayPath = join(overlayDir, entry.name)
    const targetPath = join(sourceAgentDir, ...nextSegments)
    const stats = getPathStats(overlayPath)
    if (!stats) {
      completed = false
      continue
    }
    if (stats.isSymbolicLink()) {
      continue
    }
    if (stats.isDirectory()) {
      const targetStats = getPathStats(targetPath)
      if (targetStats && !isSafeDescendCandidate(targetStats)) {
        continue
      }
      if (!targetStats) {
        try {
          mkdirSync(targetPath, { recursive: true })
        } catch {
          completed = false
          continue
        }
      }
      completed =
        copyMissingLegacyOmpOverlayEntries(
          overlayPath,
          sourceAgentDir,
          nextSegments,
          copiedFilePaths
        ) && completed
      continue
    }
    if (!stats.isFile()) {
      continue
    }
    completed = copyLegacyFile(overlayPath, targetPath, copiedFilePaths) && completed
  }

  return (
    copyDeferredSidecars(overlayDir, sourceAgentDir, copiedFilePaths, deferredSidecars) && completed
  )
}

export function migrateLegacyOmpOverlayState(sourceAgentDir: string, overlayDir: string): void {
  // Why: temporary rescue shim for OMP builds from the legacy overlay window.
  // Remove after 2026-08-07 once affected users have had a full upgrade window.
  const overlayStats = getPathStats(overlayDir)
  if (!overlayStats || overlayStats.isSymbolicLink() || !overlayStats.isDirectory()) {
    return
  }
  const markerPath = join(overlayDir, LEGACY_OMP_OVERLAY_MIGRATION_MARKER_FILE)
  if (getPathStats(markerPath)) {
    return
  }
  try {
    mkdirSync(sourceAgentDir, { recursive: true })
    // Why: some pre-managed-extension builds pointed OMP at this overlay, so
    // first-login auth/session files can exist only there after an update.
    if (copyMissingLegacyOmpOverlayEntries(overlayDir, sourceAgentDir)) {
      // Why: legacy source overlays can be large and are intentionally kept
      // for recovery; mark clean migrations so future OMP spawns stay cheap.
      writeFileSync(markerPath, 'complete\n')
    }
  } catch (error) {
    console.warn('[pi-titlebar-extension] failed to migrate legacy OMP overlay state:', error)
  }
}
