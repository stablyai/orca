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

// What each scope costs on an index the size of a real transcript tree.
//
// The 10.5 MB corpus in `session-search-query-benchmark.ts` sizes the route
// ladder; this one sizes the corpus. `conversation` is a column filter over the
// one FTS table rather than a second table of its own, and the whole cost of
// that decision is how much of `messages_fts` a conversation query has to read
// past — which is set by how much of a transcript is tool output.
//
// Synthetic, always: this must never be pointed at a real transcript.

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
    // The store's own handle, which is what a composed reader gets: every
    // retrieval is one synchronous statement, so nothing pins a WAL snapshot.
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

/**
 * The query sets, one per rung of the ladder the engine may take.
 *
 * Which rung each one reaches is not forced, it is observed: samples are
 * bucketed by the route the engine reports, so the table says what was measured
 * rather than what was intended, and a query that lands on a different rung
 * than expected shows up as a bucket rather than as a wrong number.
 */
function queries(): string[] {
  const run = (index: number, length: number): string =>
    Array.from({ length }, (_unused, step) => QUERIES[(index + step) % QUERIES.length]).join(' ')
  return [
    // Two terms, unquoted: not literal, so straight to OR.
    ...QUERIES,
    // Two terms, quoted: literal, and on this corpus any two of fourteen words
    // sit next to each other somewhere, so the phrase rung answers.
    ...QUERIES.map((query) => `"${query}"`),
    // Eight terms, quoted: an ordered run that long does not occur in 105 MB of
    // draws from fourteen words, so the phrase rung misses and AND answers.
    ...QUERIES.map((_query, index) => `"${run(index, 4)}"`)
  ]
}

type Bucket = { samples: number[]; hits: number }

/**
 * Both scopes over the same queries, interleaved scope by scope: run back to
 * back, the first one pays for every page the OS cache had not seen and the
 * ordering moves p95 more than the scope does.
 */
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
