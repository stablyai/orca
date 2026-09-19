import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { openTranscriptReadStream, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { asRecord, extractString } from './session-scanner-values'
import { SessionIndexCache } from './session-scanner-session-index-cache'

// Why: Junie stores sessions under <JUNIE_HOME>/sessions/, mirroring the CLI's
// own `JUNIE_HOME ?? ~/.junie` resolution.
export function resolveJunieSessionsDir(override?: string): string {
  if (override?.trim()) {
    return override.trim()
  }
  const home = process.env.JUNIE_HOME?.trim() || join(homedir(), '.junie')
  return join(home, 'sessions')
}

// Layout: <home>/sessions/session-<stamp>-<rand>/events.jsonl (+ optional state.json).
// The session id is the directory name, which is what `junie --resume --session-id <id>` takes.
export function junieSessionIdFromEventsPath(eventsPath: string): string {
  return basename(dirname(eventsPath))
}

// Walk up from a session's events.jsonl to the shared sessions/index.jsonl so
// metadata (projectDir, taskName) is located without trusting embedded paths.
export function junieSessionIndexPathFromEventsPath(eventsPath: string): string {
  const sessionDir = dirname(eventsPath) // .../session-<stamp>-<rand>
  const sessionsDir = dirname(sessionDir) // .../sessions
  return join(sessionsDir, 'index.jsonl')
}

export type JunieSessionSummary = {
  projectDir: string | null
  taskName: string | null
  createdAt: number | null
  updatedAt: number | null
}

// Why: every session under one Junie home shares a single index.jsonl. Re-reading
// it once per session would be O(n^2); memoize by path + file identity so a scan
// reads the index at most once (same contract as Kimi's index cache).
const summaryCacheByIndexPath = new SessionIndexCache<Map<string, JunieSessionSummary>>()

export function clearJunieSessionIndexCache(): void {
  summaryCacheByIndexPath.clear()
}

export function hasJunieSessionIndexCacheEntryForTests(indexPath: string): boolean {
  return summaryCacheByIndexPath.has(indexPath)
}

export async function readJunieSummaryBySessionId(
  indexPath: string
): Promise<Map<string, JunieSessionSummary>> {
  const generation = summaryCacheByIndexPath.beginRead()
  let identity: Awaited<ReturnType<typeof wslGatedStat>>
  try {
    identity = await wslGatedStat(indexPath, 'scan')
  } catch {
    // Missing index (e.g. user deleted it): sessions still list, just without cwd/title.
    summaryCacheByIndexPath.delete(indexPath, generation)
    return new Map()
  }

  return summaryCacheByIndexPath.get(
    indexPath,
    {
      changeTimeMs: identity.ctimeMs,
      mtimeMs: identity.mtimeMs,
      sizeBytes: identity.size
    },
    generation,
    () =>
      parseJunieSessionIndex(indexPath).then(({ map, refused }) => {
        // Why: a gate refusal is a stalled distro, not a metadata-less index — evict
        // so the partial map is not served until the index's identity changes.
        if (refused) {
          summaryCacheByIndexPath.delete(indexPath, generation)
        }
        return map
      })
  )
}

async function parseJunieSessionIndex(
  indexPath: string
): Promise<{ map: Map<string, JunieSessionSummary>; refused: boolean }> {
  const map = new Map<string, JunieSessionSummary>()
  // Why: never reject. This promise is memoized and shared by every session under
  // one Junie home; a mid-read failure must degrade to whatever was parsed.
  try {
    const lines = createInterface({
      input: openTranscriptReadStream(indexPath, { encoding: 'utf-8' }, 'scan'),
      crlfDelay: Infinity
    })
    for await (const line of lines) {
      if (!line.trim()) {
        continue
      }
      let record: Record<string, unknown> | null
      try {
        record = asRecord(JSON.parse(line) as unknown)
      } catch {
        continue
      }
      const sessionId = extractString(record?.sessionId)
      if (!sessionId) {
        continue
      }
      // Why last-wins rather than first: the index is rewritten whole under a file lock, but
      // a writer that cannot take the lock within 2s skips its update, so duplicates are possible
      // and the newest entry is the one to trust. Transcript timestamps correct the resulting lag.
      map.set(sessionId, {
        projectDir: extractString(record?.projectDir) ?? null,
        taskName: extractString(record?.taskName) ?? null,
        createdAt: epochMillis(record?.createdAt),
        updatedAt: epochMillis(record?.updatedAt)
      })
    }
  } catch (error) {
    // Return the partial map gathered before the read error.
    return { map, refused: error instanceof WslTranscriptFsError }
  }
  return { map, refused: false }
}

function epochMillis(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}
