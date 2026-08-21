import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
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
} from './browser-cookie-staged-import'
import { resolveChromiumCookiesPath } from './chromium-cookie-path'

type PendingCookieImportTarget = {
  // Why: lazy so a pre-ready app.getPath('userData') throw is swallowed where it always was.
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
  // Why: replay must overwrite the same (modern or legacy) DB the importing partition already uses.
  return resolveChromiumCookiesPath(partitionDir) ?? join(partitionDir, 'Cookies')
}

function consumeStagedCookieImport(stagedPath: string): void {
  // Why: metadata persistence is best-effort. Move the replay source out of its recorded path
  // before updating metadata so a simultaneous metadata-write failure cannot replay it next start.
  const consumedPath = `${stagedPath}.consumed`
  renameFileWithWindowsRetry(stagedPath, consumedPath)
  for (const path of [consumedPath, `${stagedPath}-wal`, `${stagedPath}-shm`]) {
    try {
      unlinkSync(path)
    } catch {
      /* the recorded replay path is already absent */
    }
  }
}

// Why: must run before any session.fromPartition() so CookieMonster reads the staged cookies instead of overwriting them from its in-memory DB.
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
    // Why: replay writes to partition-derived paths, so corrupted metadata must pass the same validation as the webview allowlist.
    const knownPartitions = new Set([defaultPartition])
    for (const profile of meta.profiles) {
      if (isValidPersistedBrowserSessionProfile(profile, activeOrcaProfileId)) {
        knownPartitions.add(profile.partition)
      }
    }
    const remainingEntries = { ...meta.pendingCookieImports }

    for (const [partition, pendingEntry] of pendingEntries) {
      if (!knownPartitions.has(partition)) {
        delete remainingEntries[partition]
        continue
      }
      const scopedPath = scopedPendingPath(pendingEntry)
      const stagedPath = typeof pendingEntry === 'string' ? pendingEntry : scopedPath
      // Why: future formats must remain pending for a newer build instead of being replayed as a
      // legacy whole image or silently discarded by an older one.
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
        // Why: a scoped stage is still a complete valid image. If the live DB was removed, copying
        // it cannot overwrite a newer unrelated cookie and avoids creating an empty DB that can
        // never satisfy the scoped merge's schema check.
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
          // Why: staged imports written before scoped replay existed have no marker. Preserve their
          // existing whole-image behavior so an update does not strand an already pending import.
          copyFileSync(stagedPath, liveCookiesPath)
          // Why: stale WAL/SHM sidecars would corrupt CookieMonster's read of the freshly swapped DB.
          let sidecarCopyFailed = false
          for (const suffix of ['-wal', '-shm']) {
            try {
              unlinkSync(liveCookiesPath + suffix)
            } catch {
              /* may not exist */
            }
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
            // Why: sidecar copy failed → inconsistent replay; keep this entry for retry.
            continue
          }
          if (copiedScopedImage) {
            removeCookieImportScopeMarker(liveCookiesPath)
          }
        }
        consumeStagedCookieImport(stagedPath)
        delete remainingEntries[partition]
      } catch {
        // Why: keep this entry for retry — one partition's failed replay shouldn't drop unrelated entries.
      }
    }
    persistBrowserSessionMeta(resolveMetadataPath, defaultPartition, {
      pendingCookieImports: remainingEntries,
      pendingCookieDbPath: legacyPendingPath(remainingEntries[defaultPartition])
    })
  } catch {
    // best-effort — if this fails, CookieMonster loads the old DB
  }
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

// Why: a degraded import still rewrites the live session, so an older staged DB must stop replaying over it.
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
  // Why: metadata writes and file removal are both best-effort. Consuming the recorded path first
  // and then persisting its removal gives either operation a chance to prevent a stale replay.
  if (existsSync(stagedPath)) {
    try {
      consumeStagedCookieImport(stagedPath)
    } catch {
      /* metadata removal below is the fallback */
    }
  }
  delete pendingCookieImports[partition]
  persistBrowserSessionMeta(resolveMetadataPath, defaultPartition, {
    pendingCookieImports,
    pendingCookieDbPath: legacyPendingPath(pendingCookieImports[defaultPartition])
  })
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(stagedPath + suffix)
    } catch {
      /* best-effort */
    }
  }
}
