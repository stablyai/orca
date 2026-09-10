import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from '../../src/main/ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../../src/main/ai-vault/session-transcript-consumers'
import {
  andExpression,
  phraseExpression,
  planSessionSearchQuery
} from '../../src/main/ai-vault-search/session-search-query-planner'
import { registerSessionSearchIndexConsumer } from '../../src/main/ai-vault-search/session-search-index-consumer'
import { openSessionSearchDatabase } from '../../src/main/ai-vault-search/session-search-schema'
import { SessionSearchStore } from '../../src/main/ai-vault-search/session-search-store'
import { sessionCandidate } from '../../src/main/ai-vault-search/session-search-transcript-fixtures'
import type SyncDatabase from '../../src/main/sqlite/sync-database'
import { writeToolHeavyCorpus, type ToolHeavyCorpus } from './session-search-tool-heavy-corpus'

// Open decision 3: `conversation_fts` holds a copy of the two prose columns and
// costs about a quarter of the index. A column filter over `messages_fts`
// returns the same rows, so the only question is what it costs to read them out
// of a table that also holds every byte of tool output. This is that
// measurement, on a corpus sized and shaped like a real transcript tree (see
// session-search-tool-heavy-corpus).

const WARMUP = 5

/** The queries the two arms answer; every one is a conversation-scope shape. */
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
  const indexPath = join(corpus.root, 'index.sqlite')
  const store = new SessionSearchStore(indexPath, (error) => {
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
  const db = openSessionSearchDatabase(indexPath)
  return {
    db,
    release: () => {
      unregister()
      resetTranscriptConsumersForTests()
      resetSessionParseCacheForTests()
      db.close()
      store.close()
    }
  }
}

/**
 * The engine's own retrieval shape, so the two arms differ in nothing but the
 * table they read and the expression that names the columns.
 */
function matchSql(table: string, weights: string): string {
  return `WITH matched AS MATERIALIZED (
    SELECT ${table}.rowid AS rowid, -bm25(${table}, ${weights}) AS score,
      m.session_row_id, m.role, m.ts, s.updated_at
    FROM ${table} JOIN messages m ON m.id = ${table}.rowid
    JOIN sessions s ON s.id = m.session_row_id WHERE ${table} MATCH ?)
  SELECT rowid, max(score) AS score, session_row_id, role, ts FROM matched
  GROUP BY session_row_id ORDER BY score DESC LIMIT 600`
}

const ARMS = {
  conversation: { table: 'conversation_fts', weights: '3.0, 2.0', filtered: false },
  columnFiltered: { table: 'messages_fts', weights: '3.0, 2.0, 0.0, 0.0', filtered: true }
} as const

/** `{user_text assistant_text} : (expr)` is what makes the wide table answer the narrow one. */
function expressionFor(arm: keyof typeof ARMS, expression: string): string {
  return ARMS[arm].filtered ? `{user_text assistant_text} : (${expression})` : expression
}

type Timing = { p50: number; p95: number }

function timing(samples: readonly number[]): Timing {
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (fraction: number): number =>
    Math.round(
      (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0) * 100
    ) / 100
  return { p50: at(0.5), p95: at(0.95) }
}

type Route = 'phrase' | 'and'

function expressions(route: Route): string[] {
  return QUERIES.map((query) => {
    const plan = planSessionSearchQuery(query)
    return route === 'phrase' ? phraseExpression(plan.body) : andExpression(plan.body)
  })
}

/** Every arm's rowid set for one expression, so "identical" is checked, not assumed. */
function rowids(db: SyncDatabase, arm: keyof typeof ARMS, expression: string): number[] {
  const { table } = ARMS[arm]
  return (
    db
      .prepare(
        `SELECT ${table}.rowid AS rowid FROM ${table}
         JOIN messages m ON m.id = ${table}.rowid
         JOIN sessions s ON s.id = m.session_row_id
         WHERE ${table} MATCH ? ORDER BY ${table}.rowid`
      )
      .all(expressionFor(arm, expression)) as { rowid: number }[]
  ).map((row) => row.rowid)
}

/** Rows the wide table matches before the column filter cuts them. */
function unfilteredRowCount(db: SyncDatabase, expression: string): number {
  return Number(
    (
      db
        .prepare('SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH ?')
        .get(expression) as { c: number }
    ).c
  )
}

function measure(db: SyncDatabase, route: Route): Record<string, unknown> {
  const built = expressions(route)
  const report: Record<string, unknown> = {}
  const statements = Object.fromEntries(
    Object.entries(ARMS).map(([name, arm]) => [name, db.prepare(matchSql(arm.table, arm.weights))])
  )
  // Interleaved arm by arm: run back to back, the first one pays for every page
  // the OS cache had not seen and the ordering moves p95 more than the arm does.
  const samples: Record<string, number[]> = { conversation: [], columnFiltered: [] }
  let matchedRows = 0
  for (let run = 0; run < WARMUP; run++) {
    for (const arm of Object.keys(ARMS) as (keyof typeof ARMS)[]) {
      for (const expression of built) {
        statements[arm]!.all(expressionFor(arm, expression))
      }
    }
  }
  for (const expression of built) {
    for (const arm of Object.keys(ARMS) as (keyof typeof ARMS)[]) {
      const started = performance.now()
      const rows = statements[arm]!.all(expressionFor(arm, expression))
      samples[arm]!.push(performance.now() - started)
      if (arm === 'conversation') {
        matchedRows += rows.length
      }
    }
  }
  for (const arm of Object.keys(ARMS) as (keyof typeof ARMS)[]) {
    report[arm] = timing(samples[arm]!)
  }
  const mismatched = built.filter(
    (expression) =>
      rowids(db, 'conversation', expression).join() !==
      rowids(db, 'columnFiltered', expression).join()
  )
  return {
    ...report,
    queries: built.length,
    sessionsMatched: matchedRows,
    // What the column filter has to read past: the same expression without it.
    unfilteredRows: built.reduce(
      (total, expression) => total + unfilteredRowCount(db, expression),
      0
    ),
    filteredRows: built.reduce(
      (total, expression) => total + rowids(db, 'columnFiltered', expression).length,
      0
    ),
    identicalRowidSets: mismatched.length === 0,
    ...(mismatched.length > 0 ? { mismatched } : {})
  }
}

/** Bytes each FTS table occupies, so the trade has both halves. */
function tableBytes(db: SyncDatabase): Record<string, number> {
  const sum = (prefix: string): number =>
    Number(
      (
        db
          .prepare('SELECT COALESCE(SUM(pgsize),0) AS bytes FROM dbstat WHERE name LIKE ?')
          .get(`${prefix}%`) as { bytes: number }
      ).bytes
    )
  const total = Number(
    (db.prepare('SELECT COALESCE(SUM(pgsize),0) AS bytes FROM dbstat').get() as { bytes: number })
      .bytes
  )
  const conversationFts = sum('conversation_fts')
  return {
    total,
    messagesFts: sum('messages_fts'),
    conversationFts,
    // The other half of the trade: what deleting the table gives back.
    conversationFtsShare: Math.round((conversationFts / total) * 1000) / 1000
  }
}

const targetMb = Number(process.env.CORPUS_MB ?? 100)
const toolShare = Number(process.env.TOOL_SHARE ?? 0.9)
const corpus = await writeToolHeavyCorpus({
  targetBytes: targetMb * 1024 * 1024,
  toolShare
})
let report: string
const indexed = await indexCorpus(corpus)
try {
  let sizes: Record<string, number> | { unavailable: string } = { unavailable: 'no dbstat' }
  try {
    sizes = tableBytes(indexed.db)
  } catch {
    // dbstat is a compile-time option; the latency numbers stand without it.
  }
  report = JSON.stringify(
    {
      corpus: {
        sessions: corpus.files.length,
        transcriptMb: Math.round((corpus.transcriptBytes / 1024 / 1024) * 100) / 100,
        toolShareOfMessageText:
          Math.round((corpus.toolBytes / (corpus.toolBytes + corpus.proseBytes)) * 1000) / 1000
      },
      indexBytes: sizes,
      phrase: measure(indexed.db, 'phrase'),
      and: measure(indexed.db, 'and')
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
