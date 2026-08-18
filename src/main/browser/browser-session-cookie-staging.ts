import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NON_TRANSPLANTABLE_HOST_KEY_SQL } from './browser-cookie-import-policy'
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
        // Why (#14686): the staged DB is a full copy of that profile's jar. Dropping only the
        // pointer here — a profile deleted while its import was in flight, or corrupt persisted
        // metadata — would strand that copy in userData with nothing left able to reclaim it.
        for (const suffix of ['', '-wal', '-shm']) {
          try {
            unlinkSync(stagedPath + suffix)
          } catch {
            /* best-effort */
          }
        }
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

// Why (#14686): the staged DB is a copy of the LIVE jar with only the non-transplantable rows kept
// (browser-cookie-import.ts deletes everything else), so a Google clear that touches the live
// session alone is silently undone the next time the replay copies that DB back over the jar. Strip
// the same family from the staged DB so the clear survives a cold start without discarding the
// imported cookies the replay exists to deliver.
// This strips ROWS and deliberately KEEPS the pending entry registered: an import that registers
// its snapshot before a clear arrives relies on the clear finding that entry here. Unregistering
// instead would drop the restart replay AND reopen that window.
export function clearPendingBrowserCookieImportNonTransplantable({
  resolveMetadataPath,
  defaultPartition,
  partition
}: PendingCookieImportTarget & { partition: string }): void {
  const stagedPath = loadBrowserSessionMeta(resolveMetadataPath, defaultPartition)
    .pendingCookieImports[partition]
  if (!stagedPath || !existsSync(stagedPath)) {
    return
  }
  let edited = false
  let db: InstanceType<typeof DatabaseSync> | null = null
  try {
    db = new DatabaseSync(stagedPath)
    // Why: the replay copies the main DB and only -wal/-shm beside it, so a deletion left in a
    // sidecar is not load-bearing — it is simply lost, and the rows come back. Rollback-journal
    // mode checkpoints any existing WAL into the main file and keeps this edit self-contained.
    // The pragma reports the resulting mode instead of failing, so read it rather than assuming.
    const journalMode = db.prepare('PRAGMA journal_mode = DELETE').get() as
      | { journal_mode?: string }
      | undefined
    if (journalMode?.journal_mode !== 'delete') {
      throw new Error(
        `Could not make the staged cookie database self-contained: ${String(journalMode?.journal_mode)}`
      )
    }
    db.exec(`DELETE FROM cookies WHERE ${NON_TRANSPLANTABLE_HOST_KEY_SQL}`)
    edited = true
  } catch {
    // Why: handled after the handle is closed — Windows refuses to unlink an open file, and
    // `new DatabaseSync` succeeds on a non-database file, so the throw arrives with it open.
  } finally {
    try {
      db?.close()
    } catch {
      /* best-effort */
    }
  }
  if (!edited) {
    // Why: a staged DB we cannot edit would replay the cleared session back. Dropping the replay
    // costs the cookies that still needed a restart — recoverable by importing again — whereas
    // keeping it would resurrect a session the user explicitly asked us to delete.
    clearPendingBrowserCookieImport({ resolveMetadataPath, defaultPartition, partition })
  }
}
