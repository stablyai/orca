import {
  currentSessionDiscovery,
  type SessionDiscoveryDependency
} from '../../session-discovery-context'
import { wslGatedReadFile, wslGatedStat } from '../../../native-chat/wsl-transcript-fs-access'
import { createSessionJsonlDependency } from '../../session-jsonl-dependency'
import { throwIfAiVaultScanCancelled, waitForAiVaultScan } from '../../ai-vault-scan-cancellation'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../../../shared/absolute-dir-override'
import { readSessionIndexJsonl, type SessionIndexJsonlRead } from '../../session-index-jsonl-read'
import { asRecord } from '../../session-scanner-record-value'
import { extractString } from '../../session-scanner-values'
import { KimiSessionIndexCache } from './session-scanner-kimi-index-cache'

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
const workDirCacheByIndexPath = new KimiSessionIndexCache<SessionIndexJsonlRead | undefined>()

export function clearKimiSessionIndexCache(): void {
  workDirCacheByIndexPath.clear()
}

export function hasKimiSessionIndexCacheEntryForTests(indexPath: string): boolean {
  return workDirCacheByIndexPath.has(indexPath)
}

export async function readKimiWorkDirBySessionId(
  indexPath: string,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const generation = workDirCacheByIndexPath.beginRead()
  let identity: Awaited<ReturnType<typeof wslGatedStat>>
  try {
    identity = await waitForAiVaultScan(wslGatedStat(indexPath, 'scan', signal), signal)
  } catch {
    throwIfAiVaultScanCancelled(signal)
    // Failed index stats leave sessions listed without cwd; discard cached enrichment for retry.
    workDirCacheByIndexPath.delete(indexPath, generation)
    return new Map()
  }

  return waitForAiVaultScan(
    workDirCacheByIndexPath.get(
      indexPath,
      {
        dev: identity.dev,
        ino: identity.ino,
        changeTimeMs: identity.ctimeMs,
        mtimeMs: identity.mtimeMs,
        sizeBytes: identity.size
      },
      generation,
      async (previous) => {
        try {
          return await readSessionIndexJsonl(
            indexPath,
            identity,
            await previous,
            parseKimiWorkDirRecord
          )
        } catch {
          // Refusal never becomes an accepted signature; the next caller must retry.
          workDirCacheByIndexPath.delete(indexPath, generation)
          return undefined
        }
      }
    ),
    signal
  ).then((read) => read?.values ?? new Map<string, string>())
}

function parseKimiWorkDirRecord(line: string): readonly [string, string] | null {
  let record: Record<string, unknown> | null
  try {
    record = asRecord(JSON.parse(line) as unknown)
  } catch {
    return null
  }
  const id = extractString(record?.sessionId),
    cwd = extractString(record?.workDir)
  return id && cwd ? [id, cwd] : null
}

export const kimiSearchDependencies: (root: string) => readonly SessionDiscoveryDependency[] = (
  root
) => [
  {
    path: dirname(root),
    mode: 'shallow',
    fileKey: (path) => basename(dirname(path)),
    eventKey: (path) => (basename(path) === 'session_index.jsonl' ? 'index' : null),
    observe: (catalog) =>
      createSessionJsonlDependency(
        join(dirname(root), 'session_index.jsonl'),
        parseKimiWorkDirRecord,
        catalog
      )
  }
]

export async function kimiSearchWirePath(
  statePath: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  if (!currentSessionDiscovery()) {
    return undefined
  }
  const value: unknown = JSON.parse(await wslGatedReadFile(statePath, 'utf-8', 'scan', signal))
  return kimiPrimaryAgentWirePath(statePath, asRecord(value))
}
