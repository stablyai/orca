import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { scanClaudeUsageFiles } from '../main/claude-usage/scanner'
import { CLAUDE_USAGE_SCHEMA_VERSION } from '../main/claude-usage/claude-usage-schema-version'
import type {
  ClaudeUsageDailyAggregate,
  ClaudeUsagePersistedFile,
  ClaudeUsageSession
} from '../main/claude-usage/types'
import {
  claudeUsageScanPageCount,
  isUsageRelayRecord,
  sliceClaudeUsageScanPage,
  type SshClaudeUsageScanParams,
  type SshClaudeUsageScanResult
} from '../main/claude-usage/ssh-usage-relay-contract'
import { RELAY_REMOTE_DIR } from '../main/ssh/relay-protocol'

type RelayClaudeUsageCache = {
  schemaVersion: number
  worktreeFingerprint: string
  processedFiles: ClaudeUsagePersistedFile[]
}

type RelayClaudeUsageLastScan = {
  scanId: string
  sessions: ClaudeUsageSession[]
  dailyAggregates: ClaudeUsageDailyAggregate[]
}

// Why module scope plus a file: the sidecar retires after 10 idle minutes, and
// Settings refreshes far less often, so memory alone would reparse every scan.
let memoryCache: RelayClaudeUsageCache | null = null
let lastScan: RelayClaudeUsageLastScan | null = null

export function resetRelayClaudeUsageCacheForTests(): void {
  memoryCache = null
  lastScan = null
}

export function relayClaudeUsageCacheFile(remoteHome: string): string {
  return join(remoteHome, RELAY_REMOTE_DIR, 'usage', 'claude-usage-cache.json')
}

function worktreeFingerprint(params: SshClaudeUsageScanParams): string {
  return JSON.stringify(params.worktrees.map((worktree) => JSON.stringify(worktree)).sort())
}

async function loadCache(cacheFile: string): Promise<RelayClaudeUsageCache | null> {
  try {
    const record: unknown = JSON.parse(await readFile(cacheFile, 'utf-8'))
    if (
      !isUsageRelayRecord(record) ||
      record.schemaVersion !== CLAUDE_USAGE_SCHEMA_VERSION ||
      typeof record.worktreeFingerprint !== 'string' ||
      !Array.isArray(record.processedFiles)
    ) {
      return null
    }
    return {
      schemaVersion: CLAUDE_USAGE_SCHEMA_VERSION,
      worktreeFingerprint: record.worktreeFingerprint,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: written only by saveCache; the scanner re-validates each entry before reuse.
      processedFiles: record.processedFiles as ClaudeUsagePersistedFile[]
    }
  } catch {
    return null
  }
}

async function saveCache(cacheFile: string, cache: RelayClaudeUsageCache): Promise<void> {
  await mkdir(dirname(cacheFile), { recursive: true })
  const tempFile = `${cacheFile}.${process.pid}.tmp`
  await writeFile(tempFile, JSON.stringify(cache))
  await rename(tempFile, cacheFile)
}

function toPage(scan: RelayClaudeUsageLastScan, index: number): SshClaudeUsageScanResult {
  return {
    scanId: scan.scanId,
    pageIndex: index,
    pageCount: claudeUsageScanPageCount(scan.sessions.length, scan.dailyAggregates.length),
    ...sliceClaudeUsageScanPage(scan.sessions, scan.dailyAggregates, index)
  }
}

/** Scan this host's Claude transcripts; only aggregates leave the host, the per-file cache stays here. */
export async function scanRelayClaudeUsage(
  params: SshClaudeUsageScanParams,
  cacheFile: string,
  signal?: AbortSignal
): Promise<SshClaudeUsageScanResult> {
  if (params.page) {
    if (!lastScan || lastScan.scanId !== params.page.scanId) {
      throw new Error('Claude usage scan page expired; rescan required.')
    }
    return toPage(lastScan, params.page.index)
  }
  const fingerprint = worktreeFingerprint(params)
  const cache = memoryCache ?? (await loadCache(cacheFile))
  const previous = cache && cache.worktreeFingerprint === fingerprint ? cache.processedFiles : []
  const result = await scanClaudeUsageFiles(params.worktrees, previous, undefined, signal)
  memoryCache = {
    schemaVersion: CLAUDE_USAGE_SCHEMA_VERSION,
    worktreeFingerprint: fingerprint,
    processedFiles: result.processedFiles
  }
  lastScan = {
    scanId: randomUUID(),
    sessions: result.sessions,
    dailyAggregates: result.dailyAggregates
  }
  // A failed cache write only costs a reparse next time.
  await saveCache(cacheFile, memoryCache).catch(() => {})
  return toPage(lastScan, 0)
}
