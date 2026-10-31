import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from '../../src/main/ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../../src/main/ai-vault/session-transcript-consumers'
import { SessionSearchEngine } from '../../src/main/ai-vault-search/session-search-engine'
import type {
  SessionSearchRequest,
  SessionSearchScope
} from '../../src/main/ai-vault-search/session-search-engine-types'
import { registerSessionSearchIndexConsumer } from '../../src/main/ai-vault-search/session-search-index-consumer'
import { SessionSearchStore } from '../../src/main/ai-vault-search/session-search-store'
import { sessionCandidate } from '../../src/main/ai-vault-search/session-search-transcript-fixtures'
import type SyncDatabase from '../../src/main/sqlite/sync-database'
import { writeToolHeavyCorpus, type ToolHeavyCorpus } from './session-search-tool-heavy-corpus'

// Measure real-sized synthetic corpus only; never use real transcripts. Conversation queries filter one FTS table, so tool share determines postings discarded.
// Query benchmark sizes route ladder; this benchmark sizes corpus.

const WARMUP = 5

/** Conversation-shaped queries; every term is one the prose actually uses. */
const QUERIES = [
  'terminal reattach',
  'stale snapshot',
  'daemon cursor',
  'worktree index',
  'publish transaction',
  'relay daemon',
  'session cursor',
  'because stale',
  'terminal worktree',
  'index snapshot',
  'reattach cursor',
  'transaction relay',
  'snapshot session',
  'daemon publish',
  'worktree terminal',
  'cursor index',
  'stale relay',
  'session transaction',
  'publish snapshot',
  'reattach daemon'
]

async function indexCorpus(
  corpus: ToolHeavyCorpus
): Promise<{ db: SyncDatabase; release: () => void }> {
  resetSessionParseCacheForTests()
  const store = new SessionSearchStore(join(corpus.root, 'index.sqlite'), (error) => {
    throw error
  })
  const unregister = registerSessionSearchIndexConsumer(store)
  const stats = createSessionParseStats()
  for (const path of corpus.files) {
    await parseAgentSessionFileCached(
      await sessionCandidate('claude', path),
      process.platform,
      stats
    )
  }
  return {
    // Composed-reader handle uses one synchronous statement per retrieval, avoiding pinned WAL snapshot.
    db: store.connection,
    release: () => {
      unregister()
      resetTranscriptConsumersForTests()
      resetSessionParseCacheForTests()
      store.close()
    }
  }
}

type Timing = { p50: number; p95: number }

function timing(samples: readonly number[]): Timing {
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (fraction: number): number => {
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
    return Math.round((sorted[index] ?? 0) * 100) / 100
  }
  return { p50: at(0.5), p95: at(0.95) }
}

// Bucket by observed engine route rather than intended ladder rung so unexpected routing remains visible.
function queries(): string[] {
  const run = (index: number, length: number): string =>
    Array.from({ length }, (_unused, step) => QUERIES[(index + step) % QUERIES.length]).join(' ')
  return [
    // Unquoted pairs use the current phrase/AND/OR retrieval ladder.
    ...QUERIES,
    // Quoted pairs sample phrase matching in the fourteen-word corpus.
    ...QUERIES.map((query) => `"${query}"`),
    // Longer quoted runs sample fallback routes; reports group by the observed route.
    ...QUERIES.map((_query, index) => `"${run(index, 4)}"`)
  ]
}

type Bucket = { samples: number[]; hits: number }

// Interleave both scopes on identical queries to share OS-cache warming instead of favoring second batch.
function scopeReport(db: SyncDatabase): Record<string, unknown> {
  const engine = new SessionSearchEngine(db)
  const scopes: SessionSearchScope[] = ['all', 'conversation']
  const requests: SessionSearchRequest[] = queries().map((query) => ({ query }))
  const buckets = new Map<string, Bucket>()
  for (let run = 0; run < WARMUP; run++) {
    for (const scope of scopes) {
      for (const request of requests) {
        engine.search({ ...request, scope })
      }
    }
  }
  for (const request of requests) {
    for (const scope of scopes) {
      const started = performance.now()
      const result = engine.search({ ...request, scope })
      const elapsed = performance.now() - started
      const key = `${result.planner.route}/${scope}`
      const bucket = buckets.get(key) ?? { samples: [], hits: 0 }
      bucket.samples.push(elapsed)
      bucket.hits += result.hits.length
      buckets.set(key, bucket)
    }
  }
  const report: Record<string, unknown> = {}
  for (const [key, bucket] of [...buckets].sort(([left], [right]) => left.localeCompare(right))) {
    report[key] = { ...timing(bucket.samples), samples: bucket.samples.length, hits: bucket.hits }
  }
  return report
}

/** Bytes the FTS table occupies, which is the cost the deleted second table saved. */
function indexBytes(db: SyncDatabase): Record<string, number> | { unavailable: string } {
  try {
    const sum = (where: string, ...values: string[]): number =>
      Number(
        (
          db
            .prepare(`SELECT COALESCE(SUM(pgsize),0) AS bytes FROM dbstat ${where}`)
            .get(...values) as { bytes: number }
        ).bytes
      )
    return { total: sum(''), messagesFts: sum('WHERE name LIKE ?', 'messages_fts%') }
  } catch {
    // dbstat is a compile-time option; the latency numbers stand without it.
    return { unavailable: 'no dbstat' }
  }
}

const corpus = await writeToolHeavyCorpus({
  targetBytes: Number(process.env.CORPUS_MB ?? 100) * 1024 * 1024,
  toolShare: Number(process.env.TOOL_SHARE ?? 0.9)
})
let report: string
const indexed = await indexCorpus(corpus)
try {
  report = JSON.stringify(
    {
      corpus: {
        sessions: corpus.files.length,
        transcriptMb: Math.round((corpus.transcriptBytes / 1024 / 1024) * 100) / 100,
        toolShareOfMessageText:
          Math.round((corpus.toolBytes / (corpus.toolBytes + corpus.proseBytes)) * 1000) / 1000
      },
      indexBytes: indexBytes(indexed.db),
      route: scopeReport(indexed.db)
    },
    null,
    2
  )
} finally {
  indexed.release()
  await rm(corpus.root, { recursive: true, force: true })
}

const out = process.env.BENCH_OUT
if (out) {
  await writeFile(out, `${report}\n`)
}
console.log(report)
