import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { asRecord, extractString } from './session-scanner-values'
import {
  KimiSessionIndexCache,
  KIMI_WORK_DIR_CACHE_MAX_INDEX_PATHS,
  KIMI_WORK_DIR_CACHE_TTL_MS
} from './session-scanner-kimi-index-cache'

export { KIMI_WORK_DIR_CACHE_MAX_INDEX_PATHS, KIMI_WORK_DIR_CACHE_TTL_MS }

// Why: Kimi Code stores sessions under <KIMI_CODE_HOME>/sessions/, mirroring the
// CLI's own `KIMI_CODE_HOME ?? ~/.kimi-code` resolution (see kimi-fetcher.ts).
export function resolveKimiSessionsDir(override?: string): string {
  if (override?.trim()) {
    return override.trim()
  }
  const home = process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code')
  return join(home, 'sessions')
}

// Layout: <home>/sessions/wd_<name>_<hash>/session_<uuid>/state.json
// The session id is the session directory name (it keeps the `session_` prefix,
// which is exactly what `kimi --session <id>` expects).
export function kimiSessionIdFromStatePath(statePath: string): string {
  return basename(dirname(statePath))
}

// Walk up from a session's state.json to the Kimi home directory so the
// top-level session_index.jsonl (which holds the real workDir) can be located
// without trusting absolute paths embedded in state.json.
export function kimiSessionIndexPathFromStatePath(statePath: string): string {
  const sessionDir = dirname(statePath) // .../session_<uuid>
  const workspaceDir = dirname(sessionDir) // .../wd_<name>_<hash>
  const sessionsDir = dirname(workspaceDir) // .../sessions
  const home = dirname(sessionsDir) // .../<KIMI_CODE_HOME>
  return join(home, 'session_index.jsonl')
}

// Why: the primary agent transcript lives at <sessionDir>/agents/<id>/wire.jsonl.
// The id is the key in state.json's `agents` map whose `type` is "main"; default
// to "main" when the map is missing so a malformed state.json still resolves a
// plausible path.
export function kimiPrimaryAgentWirePath(
  statePath: string,
  stateRecord: Record<string, unknown> | null
): string {
  const agents = asRecord(stateRecord?.agents)
  let primaryId = 'main'
  if (agents) {
    for (const [id, value] of Object.entries(agents)) {
      const record = asRecord(value)
      if (record?.type === 'main' && record.parentAgentId == null) {
        primaryId = id
        break
      }
    }
  }
  return join(dirname(statePath), 'agents', primaryId, 'wire.jsonl')
}

// Why: every session under one Kimi home shares a single session_index.jsonl.
// Re-reading it once per session would be O(n^2); memoize by path + file
// identity so a scan reads the index at most once. Bound and expire entries
// because host/WSL/runtime roots can change during one main-process lifetime.
const workDirCacheByIndexPath = new KimiSessionIndexCache()

export function clearKimiSessionIndexCache(): void {
  workDirCacheByIndexPath.clear()
}

export function hasKimiSessionIndexCacheEntryForTests(indexPath: string): boolean {
  return workDirCacheByIndexPath.has(indexPath)
}

export async function readKimiWorkDirBySessionId(indexPath: string): Promise<Map<string, string>> {
  const generation = workDirCacheByIndexPath.beginRead()
  let identity: Awaited<ReturnType<typeof stat>>
  try {
    identity = await stat(indexPath)
  } catch {
    // Missing index (e.g. user deleted it): sessions still list, just without cwd.
    workDirCacheByIndexPath.delete(indexPath, generation)
    return new Map()
  }

  return workDirCacheByIndexPath.get(
    indexPath,
    {
      changeTimeMs: identity.ctimeMs,
      mtimeMs: identity.mtimeMs,
      sizeBytes: identity.size
    },
    generation,
    () => parseKimiSessionIndex(indexPath)
  )
}

async function parseKimiSessionIndex(indexPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  // Why: never reject. This promise is memoized and shared by every session
  // under one Kimi home; a mid-read failure (file deleted after stat, EACCES)
  // must degrade to whatever was parsed so the other sessions still list.
  try {
    const lines = createInterface({
      input: createReadStream(indexPath, { encoding: 'utf-8' }),
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
      const workDir = extractString(record?.workDir)
      if (sessionId && workDir) {
        // Later lines win so a resumed session reflects its most recent workDir.
        map.set(sessionId, workDir)
      }
    }
  } catch {
    // Return the partial map gathered before the read error.
  }
  return map
}
