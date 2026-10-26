import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isBrowserRoutePartition } from './browser-route-identity'
import {
  loadBrowserSessionMeta,
  persistBrowserSessionMeta,
  type PendingBrowserCookieImport
} from './browser-session-meta-store'
import { isValidPersistedBrowserSessionProfile } from './browser-session-persisted-profile-validation'
import { renameFileWithWindowsRetry } from '../codex-accounts/fs-utils'
import {
  applyScopedStagedCookieImport,
  isScopedStagedCookieImport,
  removeCookieImportScopeMarker,
  SCOPED_COOKIE_IMPORT_FORMAT
} from './cookies/browser-cookie-staged-import'
import { resolveChromiumCookiesPath } from './chromium-cookie-path'

// Runtime-derived route partitions lack startup replay metadata and would strand plaintext cookie DBs.
export function supportsPendingBrowserCookieImportReplay(partition: string): boolean {
  return !isBrowserRoutePartition(partition)
}

function unlinkStagedCookieDb(stagedPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(stagedPath + suffix)
    } catch {}
  }
}

type PendingCookieImportTarget = {
  // Resolve inside the caller's error boundary.
  resolveMetadataPath: () => string
  defaultPartition: string
}

function legacyPendingPath(entry: PendingBrowserCookieImport | undefined): string | null {
  return typeof entry === 'string' ? entry : null
}

function scopedPendingPath(entry: PendingBrowserCookieImport): string | null {
  return typeof entry !== 'string' && entry.format === SCOPED_COOKIE_IMPORT_FORMAT
    ? entry.path
    : null
}

function partitionCookiesPath(partition: string): string {
  const partitionName = partition.replace('persist:', '')
  const partitionDir = join(app.getPath('userData'), 'Partitions', partitionName)
  // Replay into the partition's existing modern or legacy DB location.
  return resolveChromiumCookiesPath(partitionDir) ?? join(partitionDir, 'Cookies')
}

function consumeStagedCookieImport(stagedPath: string): void {
  // Consume before updating metadata so a failed metadata write cannot replay stale cookies.
  const consumedPath = `${stagedPath}.consumed`
  renameFileWithWindowsRetry(stagedPath, consumedPath)
  for (const path of [consumedPath, `${stagedPath}-wal`, `${stagedPath}-shm`]) {
    try {
      unlinkSync(path)
    } catch {}
  }
}

// Replay before session.fromPartition opens CookieMonster's in-memory DB.
export function applyPendingBrowserCookieImports({
  resolveMetadataPath,
  defaultPartition,
  activeOrcaProfileId
}: PendingCookieImportTarget & { activeOrcaProfileId: string }): void {
  try {
    const meta = loadBrowserSessionMeta(resolveMetadataPath, defaultPartition)
    const pendingEntries = Object.entries(meta.pendingCookieImports)
    if (pendingEntries.length === 0) {
      return
    }
    // Partition-derived write paths must pass the same validation as the webview allowlist.
    const knownPartitions = new Set([defaultPartition])
    for (const profile of meta.profiles) {
      if (isValidPersistedBrowserSessionProfile(profile, activeOrcaProfileId)) {
        knownPartitions.add(profile.partition)
      }
    }
    const remainingEntries = { ...meta.pendingCookieImports }

    for (const [partition, pendingEntry] of pendingEntries) {
      if (!knownPartitions.has(partition)) {
        // Dropping metadata must not orphan a plaintext cookie DB, even for an unknown format.
        unlinkStagedCookieDb(typeof pendingEntry === 'string' ? pendingEntry : pendingEntry.path)
        delete remainingEntries[partition]
        continue
      }
      const scopedPath = scopedPendingPath(pendingEntry)
      const stagedPath = typeof pendingEntry === 'string' ? pendingEntry : scopedPath
      // Leave unknown formats pending for a newer build.
      if (!stagedPath) {
        continue
      }
      if (!existsSync(stagedPath)) {
        delete remainingEntries[partition]
        continue
      }

      const liveCookiesPath = partitionCookiesPath(partition)
      try {
        mkdirSync(join(liveCookiesPath, '..'), { recursive: true })
        // A scoped stage is a complete image; copy it if no live DB exists to merge into.
        const liveCookiesExist = existsSync(liveCookiesPath)
        const markedScopedImage = isScopedStagedCookieImport(stagedPath)
        if (scopedPath && !markedScopedImage) {
          throw new Error('Scoped cookie import is missing its scope marker')
        }
        const copiedScopedImage = !liveCookiesExist && markedScopedImage
        const appliedScopedImport =
          liveCookiesExist && markedScopedImage
            ? applyScopedStagedCookieImport(liveCookiesPath, stagedPath)
            : false
        if (!appliedScopedImport) {
          // Preserve whole-image replay for legacy stages without scope markers.
          copyFileSync(stagedPath, liveCookiesPath)
          // Stale WAL/SHM sidecars would corrupt the replaced cookie DB.
          let sidecarCopyFailed = false
          for (const suffix of ['-wal', '-shm']) {
            try {
              unlinkSync(liveCookiesPath + suffix)
            } catch {}
            const stagingSidecar = stagedPath + suffix
            if (!existsSync(stagingSidecar)) {
              continue
            }
            try {
              copyFileSync(stagingSidecar, liveCookiesPath + suffix)
            } catch {
              sidecarCopyFailed = true
            }
          }
          if (sidecarCopyFailed) {
            // Retry incomplete sidecar copies.
            continue
          }
          if (copiedScopedImage) {
            removeCookieImportScopeMarker(liveCookiesPath)
          }
        }
        consumeStagedCookieImport(stagedPath)
        delete remainingEntries[partition]
      } catch {
        // Keep failed entries pending without interrupting other partitions.
      }
    }
    persistBrowserSessionMeta(resolveMetadataPath, defaultPartition, {
      pendingCookieImports: remainingEntries,
      pendingCookieDbPath: legacyPendingPath(remainingEntries[defaultPartition])
    })
  } catch {}
}

export function setPendingBrowserCookieImport({
  resolveMetadataPath,
  defaultPartition,
  partition,
  stagingDbPath
}: PendingCookieImportTarget & { partition: string; stagingDbPath: string }): void {
  const meta = loadBrowserSessionMeta(resolveMetadataPath, defaultPartition)
  const pendingCookieImports = {
    ...meta.pendingCookieImports,
    [partition]: { format: SCOPED_COOKIE_IMPORT_FORMAT, path: stagingDbPath }
  }
  persistBrowserSessionMeta(resolveMetadataPath, defaultPartition, {
    pendingCookieImports,
    pendingCookieDbPath: legacyPendingPath(pendingCookieImports[defaultPartition])
  })
}

// Even a degraded import must prevent older staged cookies from overwriting it on restart.
export function clearPendingBrowserCookieImport({
  resolveMetadataPath,
  defaultPartition,
  partition
}: PendingCookieImportTarget & { partition: string }): void {
  const meta = loadBrowserSessionMeta(resolveMetadataPath, defaultPartition)
  if (!(partition in meta.pendingCookieImports)) {
    return
  }
  const pendingCookieImports = { ...meta.pendingCookieImports }
  const pendingEntry = pendingCookieImports[partition]
  const stagedPath = typeof pendingEntry === 'string' ? pendingEntry : pendingEntry.path
  // File consumption and metadata removal each provide a fallback against stale replay.
  if (existsSync(stagedPath)) {
    try {
      consumeStagedCookieImport(stagedPath)
    } catch {}
  }
  delete pendingCookieImports[partition]
  persistBrowserSessionMeta(resolveMetadataPath, defaultPartition, {
    pendingCookieImports,
    pendingCookieDbPath: legacyPendingPath(pendingCookieImports[defaultPartition])
  })
  unlinkStagedCookieDb(stagedPath)
}
