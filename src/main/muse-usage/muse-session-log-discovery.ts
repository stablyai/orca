import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveMuseSessionsDir } from '../../shared/muse-session-log'

const YEAR_DIR = /^\d{4}$/
const MONTH_OR_DAY_DIR = /^\d{2}$/
const SESSION_LOG = 'session.jsonl'
const SUBAGENT_DIR = 'subagent'
// Guards against a pathological or cyclic tree; real logs nest one level.
const MAX_SUBAGENT_DEPTH = 4

export type MuseSessionLogRef = {
  path: string
  /** Top-level session the log belongs to; subagent logs roll up into their parent. */
  sessionId: string
  isSubagent: boolean
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function listSubdirectories(
  dirPath: string,
  pattern?: RegExp,
  options: { reportUnreadable?: boolean } = {}
): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && (!pattern || pattern.test(entry.name)))
      .map((entry) => entry.name)
  } catch (error) {
    // Why: a missing root means "no Muse data"; any other root failure must reach lastScanError.
    if (options.reportUnreadable && !isMissingPathError(error)) {
      throw error
    }
    return []
  }
}

async function collectSubagentLogs(
  sessionDir: string,
  sessionId: string,
  depth: number,
  logs: MuseSessionLogRef[]
): Promise<void> {
  if (depth > MAX_SUBAGENT_DEPTH) {
    return
  }
  const subagentRoot = join(sessionDir, SUBAGENT_DIR)
  for (const childId of await listSubdirectories(subagentRoot)) {
    const childDir = join(subagentRoot, childId)
    logs.push({ path: join(childDir, SESSION_LOG), sessionId, isSubagent: true })
    await collectSubagentLogs(childDir, sessionId, depth + 1, logs)
  }
}

/**
 * Lists `<root>/YYYY/MM/DD/<session>/session.jsonl` plus the subagent logs under
 * `<session>/subagent/<child>/`, which hold usage the parent log does not.
 * Sorted by path so ownership claims are deterministic; Muse's dot dirs are skipped.
 */
export async function listMuseSessionLogFiles(
  sessionsDir = resolveMuseSessionsDir()
): Promise<MuseSessionLogRef[]> {
  const logs: MuseSessionLogRef[] = []
  for (const year of await listSubdirectories(sessionsDir, YEAR_DIR, {
    reportUnreadable: true
  })) {
    const yearDir = join(sessionsDir, year)
    for (const month of await listSubdirectories(yearDir, MONTH_OR_DAY_DIR)) {
      const monthDir = join(yearDir, month)
      for (const day of await listSubdirectories(monthDir, MONTH_OR_DAY_DIR)) {
        const dayDir = join(monthDir, day)
        for (const sessionId of await listSubdirectories(dayDir)) {
          const sessionDir = join(dayDir, sessionId)
          logs.push({ path: join(sessionDir, SESSION_LOG), sessionId, isSubagent: false })
          await collectSubagentLogs(sessionDir, sessionId, 1, logs)
        }
      }
    }
  }
  return logs.sort((left, right) => left.path.localeCompare(right.path))
}
