import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { loadBrowserSessionMeta, persistBrowserSessionMeta } from './browser-session-meta-store'
import { isValidPersistedBrowserSessionProfile } from './browser-session-persisted-profile-validation'
import { resolveChromiumCookiesPath } from './chromium-cookie-path'

type PendingCookieImportTarget = {
  // Why: lazy so a pre-ready app.getPath('userData') throw is swallowed where it always was.
  resolveMetadataPath: () => string
  defaultPartition: string
}

function partitionCookiesPath(partition: string): string {
  const partitionName = partition.replace('persist:', '')
  const partitionDir = join(app.getPath('userData'), 'Partitions', partitionName)
  // Why: replay must overwrite the same (modern or legacy) DB the importing partition already uses.
  return resolveChromiumCookiesPath(partitionDir) ?? join(partitionDir, 'Cookies')
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

    for (const [partition, stagedPath] of pendingEntries) {
      if (!knownPartitions.has(partition)) {
        delete remainingEntries[partition]
        continue
      }
      if (!existsSync(stagedPath)) {
        delete remainingEntries[partition]
        continue
      }

      const liveCookiesPath = partitionCookiesPath(partition)
      try {
        mkdirSync(join(liveCookiesPath, '..'), { recursive: true })
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
        for (const ext of ['', '-wal', '-shm']) {
          try {
            unlinkSync(`${stagedPath}${ext}`)
          } catch {
            /* best-effort */
          }
        }
        delete remainingEntries[partition]
      } catch {
        // Why: keep this entry for retry — one partition's failed replay shouldn't drop unrelated entries.
      }
    }
    persistBrowserSessionMeta(resolveMetadataPath, defaultPartition, {
      pendingCookieImports: remainingEntries,
      pendingCookieDbPath: remainingEntries[defaultPartition] ?? null
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
  const pendingCookieImports = { ...meta.pendingCookieImports, [partition]: stagingDbPath }
  persistBrowserSessionMeta(resolveMetadataPath, defaultPartition, {
    pendingCookieImports,
    pendingCookieDbPath: pendingCookieImports[defaultPartition] ?? null
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
  const stagedPath = pendingCookieImports[partition]
  delete pendingCookieImports[partition]
  persistBrowserSessionMeta(resolveMetadataPath, defaultPartition, {
    pendingCookieImports,
    pendingCookieDbPath: pendingCookieImports[defaultPartition] ?? null
  })
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(stagedPath + suffix)
    } catch {
      /* best-effort */
    }
  }
}
