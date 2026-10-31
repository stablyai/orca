import { lstat, readdir, rmdir, stat, unlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'

const DAY_MS = 24 * 60 * 60 * 1000
const ROLLOUT_FILE_PATTERN = /^rollout-.*\.jsonl$/

// Why: unpruned rollout logs grew to 11 GB (#16776); a quarter still covers realistic resume/search.
export const CODEX_SESSION_LOG_RETENTION_DAYS = 90

// Why: a user back from a long break keeps their newest sessions regardless of age.
export const CODEX_SESSION_LOG_MIN_RETAINED_ROLLOUTS = 50

const RETENTION_DAYS_ENV_VAR = 'ORCA_CODEX_SESSION_LOG_RETENTION_DAYS'

export type CodexSessionLogRetentionSummary = {
  scannedRollouts: number
  removedRollouts: number
  removedBytes: number
  removedDirectories: number
  failures: number
}

type RolloutFile = {
  path: string
  mtimeMs: number
  size: number
}

/** Resolved retention window in days, or null when the sweep is opted out of. */
export function resolveCodexSessionLogRetentionDays(
  env: Record<string, string | undefined> = process.env
): number | null {
  const raw = env[RETENTION_DAYS_ENV_VAR]
  if (raw === undefined) {
    return CODEX_SESSION_LOG_RETENTION_DAYS
  }
  const parsed = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(parsed) || parsed < 0) {
    return CODEX_SESSION_LOG_RETENTION_DAYS
  }
  return parsed === 0 ? null : parsed
}

/** Never throws; with `publishedSessionsRoot`, only rollouts already published there are removed. */
export async function pruneExpiredCodexSessionLogs({
  sessionsRoot,
  now = Date.now(),
  retentionDays = CODEX_SESSION_LOG_RETENTION_DAYS,
  minRetainedRollouts = CODEX_SESSION_LOG_MIN_RETAINED_ROLLOUTS,
  publishedSessionsRoot
}: {
  sessionsRoot: string
  now?: number
  retentionDays?: number
  minRetainedRollouts?: number
  publishedSessionsRoot?: string
}): Promise<CodexSessionLogRetentionSummary> {
  const summary: CodexSessionLogRetentionSummary = {
    scannedRollouts: 0,
    removedRollouts: 0,
    removedBytes: 0,
    removedDirectories: 0,
    failures: 0
  }
  const rollouts = await collectRollouts(sessionsRoot, summary)
  summary.scannedRollouts = rollouts.length
  // Newest first so the floor protects the most recent sessions.
  rollouts.sort((left, right) => right.mtimeMs - left.mtimeMs)
  const cutoffMs = now - retentionDays * DAY_MS
  for (const rollout of rollouts.slice(minRetainedRollouts)) {
    if (rollout.mtimeMs >= cutoffMs) {
      continue
    }
    if (
      publishedSessionsRoot !== undefined &&
      !(await isPublished(join(publishedSessionsRoot, relative(sessionsRoot, rollout.path))))
    ) {
      continue
    }
    try {
      // Why: Codex may have resumed this session since the scan; deleting it would orphan a live log.
      const current = await stat(rollout.path)
      if (current.mtimeMs !== rollout.mtimeMs) {
        continue
      }
      await unlink(rollout.path)
      summary.removedRollouts += 1
      summary.removedBytes += rollout.size
    } catch {
      summary.failures += 1
    }
  }
  if (summary.removedRollouts > 0) {
    await removeEmptyDirectories(sessionsRoot, summary)
  }
  return summary
}

/** Resolves to null when retention is opted out of. */
export function startCodexSessionLogRetentionSweepInBackground(
  managedCodexHomePath: string = getOrcaManagedCodexHomePath(),
  publishedSessionsRoot?: string
): Promise<CodexSessionLogRetentionSummary | null> {
  const retentionDays = resolveCodexSessionLogRetentionDays()
  if (retentionDays === null) {
    return Promise.resolve(null)
  }
  return pruneExpiredCodexSessionLogs({
    sessionsRoot: join(managedCodexHomePath, 'sessions'),
    retentionDays,
    publishedSessionsRoot
  }).catch((error: unknown) => {
    console.warn('[codex-session-log-retention] Session log sweep failed:', error)
    return null
  })
}

async function isPublished(publishedPath: string): Promise<boolean> {
  try {
    return (await lstat(publishedPath)).isFile()
  } catch {
    return false
  }
}

/** Only ENOENT means the directory is simply not there; every other errno is a real failure. */
function isDirectoryAbsence(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function collectRollouts(
  directoryPath: string,
  summary: CodexSessionLogRetentionSummary
): Promise<RolloutFile[]> {
  let entries
  try {
    entries = await readdir(directoryPath, { withFileTypes: true })
  } catch (error) {
    // No sessions root before the first Codex run is normal; anything else (incl. ENOTDIR) is a failure.
    if (!isDirectoryAbsence(error)) {
      summary.failures += 1
    }
    return []
  }
  const rollouts: RolloutFile[] = []
  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name)
    if (entry.isDirectory()) {
      rollouts.push(...(await collectRollouts(entryPath, summary)))
      continue
    }
    // isFile() excludes symlinks, so a linked-in rollout is never unlinked here.
    if (!entry.isFile() || !ROLLOUT_FILE_PATTERN.test(entry.name)) {
      continue
    }
    try {
      const stats = await stat(entryPath)
      rollouts.push({ path: entryPath, mtimeMs: stats.mtimeMs, size: stats.size })
    } catch {
      summary.failures += 1
    }
  }
  return rollouts
}

/** Removes empty descendants of `directoryPath`; returns true when it is now empty. */
async function removeEmptyDirectories(
  directoryPath: string,
  summary: CodexSessionLogRetentionSummary
): Promise<boolean> {
  let entries
  try {
    entries = await readdir(directoryPath, { withFileTypes: true })
  } catch {
    return false
  }
  let remaining = entries.length
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const childPath = join(directoryPath, entry.name)
    if (!(await removeEmptyDirectories(childPath, summary))) {
      continue
    }
    try {
      await rmdir(childPath)
      summary.removedDirectories += 1
      remaining -= 1
    } catch {
      summary.failures += 1
    }
  }
  return remaining === 0
}
