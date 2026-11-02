import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'
import { openTranscriptReadStream, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { asRecord, extractString } from './session-scanner-values'
import {
  KimiSessionIndexCache,
  KIMI_WORK_DIR_CACHE_MAX_INDEX_PATHS,
  KIMI_WORK_DIR_CACHE_TTL_MS
} from './session-scanner-kimi-index-cache'

export { KIMI_WORK_DIR_CACHE_MAX_INDEX_PATHS, KIMI_WORK_DIR_CACHE_TTL_MS }

export function resolveKimiSessionsDir(override?: string): string {
  if (override?.trim()) {
    return override.trim()
  }
  const home = resolveAbsoluteDirOverride(process.env.KIMI_CODE_HOME, join(homedir(), '.kimi-code'))
  return join(home, 'sessions')
}

// Keep the session_ directory prefix: kimi --session expects it as part of the ID.
export function kimiSessionIdFromStatePath(statePath: string): string {
  return basename(dirname(statePath))
}

// Derive the index from the discovered layout rather than trusting paths embedded in state.json.
export function kimiSessionIndexPathFromStatePath(statePath: string): string {
  const sessionDir = dirname(statePath)
  const workspaceDir = dirname(sessionDir)
  const sessionsDir = dirname(workspaceDir)
  const home = dirname(sessionsDir)
  return join(home, 'session_index.jsonl')
}

// Resolve the root main agent from state; use agents/main when no matching agent is recorded.
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

// Share parsed indexes by path and file identity; one home can hold many sessions.
const workDirCacheByIndexPath = new KimiSessionIndexCache()

export function clearKimiSessionIndexCache(): void {
  workDirCacheByIndexPath.clear()
}

export function hasKimiSessionIndexCacheEntryForTests(indexPath: string): boolean {
  return workDirCacheByIndexPath.has(indexPath)
}

export async function readKimiWorkDirBySessionId(indexPath: string): Promise<Map<string, string>> {
  const generation = workDirCacheByIndexPath.beginRead()
  let identity: Awaited<ReturnType<typeof wslGatedStat>>
  try {
    identity = await wslGatedStat(indexPath, 'scan')
  } catch {
    // Failed index stats leave sessions listed without cwd; discard cached enrichment for retry.
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
    () =>
      parseKimiSessionIndex(indexPath).then(({ map, refused }) => {
        // Evict inside the shared loader so every concurrent caller retries refused reads without a signature change.
        if (refused) {
          workDirCacheByIndexPath.delete(indexPath, generation)
        }
        return map
      })
  )
}

async function parseKimiSessionIndex(
  indexPath: string
): Promise<{ map: Map<string, string>; refused: boolean }> {
  const map = new Map<string, string>()
  // Share partial results after read failure so one broken index does not hide every session under its home.
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
      const workDir = extractString(record?.workDir)
      if (sessionId && workDir) {
        // Later lines win so a resumed session reflects its most recent workDir.
        map.set(sessionId, workDir)
      }
    }
  } catch (error) {
    return { map, refused: error instanceof WslTranscriptFsError }
  }
  return { map, refused: false }
}
