import './worker/session-search-worker.test-fixture'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'

// Replace worker transport while exercising the real SQLite readers.
type OpenCodeListHook =
  | ((
      agent: 'opencode' | 'opencode2',
      issues: AiVaultScanIssue[],
      limit: number
    ) => Promise<void> | void)
  | null
export const openCodeObservation: { hook: OpenCodeListHook } = { hook: null }
export const openCodeReadCalls: string[] = []
export const openCodeListObservations: { paths: readonly string[]; limit: number; rows: number }[] =
  []
vi.mock(
  '../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn',
  async () => {
    const list =
      await import('../ai-vault/scanners/opencode/sqlite/session-scanner-opencode-sqlite-list')
    const parse =
      await import('../ai-vault/scanners/opencode/sqlite/session-scanner-opencode-sqlite')
    const capture =
      await import('../ai-vault/scanners/opencode/sqlite/session-scanner-opencode-sqlite-capture')
    const own = await import('./session-search-opencode-index.test-fixture')
    const { listOpenCode2SqliteSessions } =
      await import('../ai-vault/scanners/opencode2/session-scanner-opencode2-sqlite-list')
    const parse2 = await import('../ai-vault/scanners/opencode2/session-scanner-opencode2-sqlite')
    return {
      parseOpenCode2SqliteSessionViaWorker: parse2.parseOpenCode2SqliteSession,
      captureOpenCode2SqliteSessionViaWorker: parse2.captureOpenCode2SqliteSession,
      listOpenCode2SqliteSessionsViaWorker: async (
        args: Parameters<typeof listOpenCode2SqliteSessions>[0]
      ) => {
        const candidates = await listOpenCode2SqliteSessions(args)
        await own.openCodeObservation.hook?.('opencode2', args.issues, args.limit)
        return candidates
      },
      resolveOpenCodeSqliteWorkerEntryPath: () => null,
      listOpenCodeSqliteSessionsViaWorker: (
        args: Parameters<typeof list.listOpenCodeSqliteSessions>[0]
      ) =>
        list.listOpenCodeSqliteSessions(args).then(async (candidates) => {
          await own.openCodeObservation.hook?.('opencode', args.issues, args.limit)
          own.openCodeListObservations.push({
            paths: args.dbPaths,
            limit: args.limit,
            rows: candidates.length
          })
          return candidates
        }),
      parseOpenCodeSqliteSessionViaWorker: (
        args: Parameters<typeof parse.parseOpenCodeSqliteSession>[0]
      ) => {
        own.openCodeReadCalls.push(`parse:${args.sessionId}`)
        return parse.parseOpenCodeSqliteSession(args)
      },
      captureOpenCodeSqliteSessionViaWorker: (
        args: Parameters<typeof capture.captureOpenCodeSqliteSession>[0]
      ) => {
        own.openCodeReadCalls.push(`capture:${args.sessionId}`)
        return capture.captureOpenCodeSqliteSession(args)
      }
    }
  }
)
import { resetSessionParseCacheForTests } from '../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../ai-vault/transcripts/session-transcript-consumers'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchEngine } from './query/session-search-engine'
import { SessionSearchIndexer } from './indexing/session-search-indexer'
import { openSessionSearchDatabase } from './storage/session-search-schema'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  type SessionSearchIndexerHarness
} from './indexing/session-search-indexer-test-fixture'

export let harness: SessionSearchIndexerHarness
export let clock: FakeSessionSearchClock
let indexer: SessionSearchIndexer | null = null
let engineDbs: SyncDatabase[] = []

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  clock = new FakeSessionSearchClock()
  harness = await openSessionSearchIndexerHarness('ss-opencode-index')
  indexer = null
  engineDbs = []
  openCodeObservation.hook = null
  openCodeReadCalls.length = 0
  openCodeListObservations.length = 0
})

afterEach(async () => {
  await indexer?.close()
  for (const db of engineDbs) {
    db.close()
  }
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

export function dbPath(): string {
  return join(harness.root, 'opencode-db', 'opencode.db')
}

export async function finishPendingObservation(subject: SessionSearchIndexer): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (subject.status().phase === 'current') {
      return
    }
    await subject.reconcile()
  }
  throw new Error('Database observation did not finish')
}

export async function startIndexer(
  options: { fullSweepEveryCycles?: number; degraded?: boolean } = {}
): Promise<SessionSearchIndexer> {
  const started = new SessionSearchIndexer({
    discoveryPolicy: 'event-led',
    databasePath: harness.databasePath,
    roots: { ...harness.roots, opencodeDbPaths: [dbPath()] },
    historyDays: null,
    clock,
    reconcileIntervalMs: 20_000,
    fullSweepEveryCycles: options.fullSweepEveryCycles ?? 1000,
    onError: (error) => {
      throw error
    }
  })
  indexer = started
  await started.start()
  if (!options.degraded) {
    await finishPendingObservation(started)
  }
  return started
}

export function openEngine(): SessionSearchEngine {
  const db = openSessionSearchDatabase(harness.databasePath)
  engineDbs.push(db)
  return new SessionSearchEngine(db)
}

export function ownIndexer(subject: SessionSearchIndexer): void {
  indexer = subject
}
