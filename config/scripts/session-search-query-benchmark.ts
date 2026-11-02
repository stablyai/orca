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
import type SyncDatabase from '../../src/main/sqlite/sync-database'
import {
  writeSyntheticTranscriptCorpus,
  type SyntheticCorpus,
  type SyntheticCorpusOptions
} from '../../src/main/ai-vault-search/session-search-synthetic-corpus'
import { sessionCandidate } from '../../src/main/ai-vault-search/session-search-transcript-fixtures'

// Measure real engine/store on synthetic corpus only; never use real transcripts.

const WARMUP = 5
const SAMPLES = 25

// One query per rung the ladder can take, plus the two shapes that skip it.
const QUERIES: { name: string; request: SessionSearchRequest }[] = [
  { name: 'phrase', request: { query: '"terminal reattach"' } },
  { name: 'identifier', request: { query: 'resolveTerminalPath' } },
  { name: 'path', request: { query: 'src/main/ai-vault/session-transcript-reader.ts' } },
  { name: 'prose', request: { query: 'why is the daemon snapshot stale' } },
  { name: 'typo', request: { query: 'reattahc worktre' } },
  { name: 'common-term', request: { query: 'index' } },
  { name: 'operator-only', request: { query: 'repo:app-3' } },
  { name: 'scoped', request: { query: 'worktree', filters: { scopePaths: ['/repo/app-3'] } } }
]

type Timing = { p50: number; p95: number }

function percentile(sorted: readonly number[], fraction: number): number {
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  return Math.round((sorted[at] ?? 0) * 100) / 100
}

function timing(samples: number[]): Timing {
  const sorted = [...samples].sort((left, right) => left - right)
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) }
}

function time(engine: SessionSearchEngine, request: SessionSearchRequest): number {
  const started = performance.now()
  engine.search(request)
  return performance.now() - started
}

async function indexCorpus(
  options: SyntheticCorpusOptions
): Promise<{ corpus: SyntheticCorpus; db: SyncDatabase; release: () => void }> {
  resetSessionParseCacheForTests()
  const corpus = await writeSyntheticTranscriptCorpus(options)
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
    corpus,
    // Composed reader performs one synchronous statement per read, preserving its handle contract.
    db: store.connection,
    release: () => {
      unregister()
      resetTranscriptConsumersForTests()
      resetSessionParseCacheForTests()
      store.close()
    }
  }
}

/** Per-query and overall latency for one scope. */
function scopeReport(db: SyncDatabase, scope: SessionSearchScope): Record<string, unknown> {
  const engine = new SessionSearchEngine(db)
  const everything: number[] = []
  const perQuery: Record<string, Timing & { hits: number; route: string }> = {}
  for (const { name, request } of QUERIES) {
    const scoped = { ...request, scope }
    for (let run = 0; run < WARMUP; run++) {
      engine.search(scoped)
    }
    const samples = Array.from({ length: SAMPLES }, () => time(engine, scoped))
    everything.push(...samples)
    const result = engine.search(scoped)
    perQuery[name] = { ...timing(samples), hits: result.hits.length, route: result.planner.route }
  }
  return { ...timing(everything), perQuery }
}

// Interleave candidate limits over many short sessions to make limit bind without favoring second arm’s warmed OS cache.
function candidateSweep(db: SyncDatabase, limits: readonly number[]): Record<string, unknown> {
  const request: SessionSearchRequest = { query: 'index', limit: 20 }
  const engines = new Map(
    limits.map((limit) => [limit, new SessionSearchEngine(db, { sessionCandidateLimit: limit })])
  )
  const samples = new Map(limits.map((limit) => [limit, [] as number[]]))
  for (let run = 0; run < WARMUP; run++) {
    for (const engine of engines.values()) {
      engine.search(request)
    }
  }
  for (let run = 0; run < SAMPLES; run++) {
    for (const limit of limits) {
      samples.get(limit)!.push(time(engines.get(limit)!, request))
    }
  }
  const report: Record<string, unknown> = {}
  for (const limit of limits) {
    const result = engines.get(limit)!.search(request)
    report[String(limit)] = {
      ...timing(samples.get(limit)!),
      truncated: result.truncated.candidates,
      // Pages a caller could walk before the limit stops handing out sessions.
      reachablePages: Math.ceil(limit / (request.limit ?? 20))
    }
  }
  return report
}

const wide = await indexCorpus({ sessions: Number(process.env.SESSIONS ?? 40) })
let report: string
try {
  const scope = {
    all: scopeReport(wide.db, 'all'),
    conversation: scopeReport(wide.db, 'conversation')
  }
  wide.release()
  await rm(wide.corpus.root, { recursive: true, force: true })

  // Session count, not byte volume, makes candidate limit binding.
  const many = await indexCorpus({ sessions: 2500, turnsPerSession: 1, seed: 7 })
  try {
    report = JSON.stringify(
      {
        scopeCorpus: {
          sessions: wide.corpus.files.length,
          transcriptMb: Math.round((wide.corpus.transcriptBytes / 1024 / 1024) * 100) / 100,
          messages: wide.corpus.messageCount
        },
        scope,
        candidateCorpus: {
          sessions: many.corpus.files.length,
          transcriptMb: Math.round((many.corpus.transcriptBytes / 1024 / 1024) * 100) / 100
        },
        candidateSweep: candidateSweep(many.db, [200, 600, 1200, 2400])
      },
      null,
      2
    )
  } finally {
    many.release()
    await rm(many.corpus.root, { recursive: true, force: true })
  }
} catch (error) {
  await rm(wide.corpus.root, { recursive: true, force: true })
  throw error
}

// Write report file too: test runners may intercept console output.
const out = process.env.BENCH_OUT
if (out) {
  await writeFile(out, `${report}\n`)
}
console.log(report)
