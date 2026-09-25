import { readdir, rmdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'

const DAY_MS = 24 * 60 * 60 * 1000
const ROLLOUT_FILE_PATTERN = /^rollout-.*\.jsonl$/

/**
 * Why 90 days: the runtime home's rollout logs are never pruned today, so they
 * grow forever (#16776 reported 11 GB over ~a year). A quarter still covers the
 * window in which resuming or searching a past session is realistic, while
 * bounding the directory to a fraction of an unbounded lifetime.
 */
export const CODEX_SESSION_LOG_RETENTION_DAYS = 90

/**
 * Why a floor: age alone would wipe every session of a user who returns after a
 * long break. Keeping the newest rollouts regardless of age means the sweep can
 * only ever remove history the user already has newer replacements for.
 */
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

/**
 * Deletes expired `rollout-*.jsonl` logs under a Codex `sessions` root and
 * removes the date directories they leave empty.
 *
 * Never throws: a sweep that cannot read or unlink one entry still reclaims the
 * rest and reports the failure count.
 */
export async function pruneExpiredCodexSessionLogs({
  sessionsRoot,
  now = Date.now(),
  retentionDays = CODEX_SESSION_LOG_RETENTION_DAYS,
  minRetainedRollouts = CODEX_SESSION_LOG_MIN_RETAINED_ROLLOUTS
}: {
  sessionsRoot: string
  now?: number
  retentionDays?: number
  minRetainedRollouts?: number
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
    try {
      // Why: the mtime that made this rollout expired was sampled during the scan, and Codex can
      // resume the session in the window before the unlink lands. Deleting it then removes a live
      // conversation from discovery and sends every later append into an unlinked file, so re-read
      // the mtime and leave anything that moved to the next sweep.
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

/**
 * Runs the retention sweep for the managed runtime home without blocking the
 * caller; resolves to null when retention is opted out of.
 */
export function startCodexSessionLogRetentionSweepInBackground(
  managedCodexHomePath: string = getOrcaManagedCodexHomePath()
): Promise<CodexSessionLogRetentionSummary | null> {
  const retentionDays = resolveCodexSessionLogRetentionDays()
  if (retentionDays === null) {
    return Promise.resolve(null)
  }
  return pruneExpiredCodexSessionLogs({
    sessionsRoot: join(managedCodexHomePath, 'sessions'),
    retentionDays
  }).catch((error: unknown) => {
    console.warn('[codex-session-log-retention] Session log sweep failed:', error)
    return null
  })
}

/** Only ENOENT means the directory is simply not there; every other errno is a real failure. */
function isDirectoryAbsence(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function collectRollouts(
  directoryPath: string,
  summary: CodexSessionLogRetentionSummary
): Promise<RolloutFile[]> {
  let entries
  try {
    entries = await readdir(directoryPath, { withFileTypes: true })
  } catch (error) {
    // An absent sessions root is the normal state before the first Codex run;
    // any other errno is a real read failure and must be counted so the summary
    // does not report a silently partial sweep as clean. ENOTDIR belongs on the
    // failure side: the path exists, it is just not a directory.
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
