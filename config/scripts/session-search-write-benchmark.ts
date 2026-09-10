import assert from 'node:assert/strict'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from '../../src/main/ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../../src/main/ai-vault/session-transcript-consumers'
import { registerSessionSearchIndexConsumer } from '../../src/main/ai-vault-search/session-search-index-consumer'
import { SessionSearchStore } from '../../src/main/ai-vault-search/session-search-store'
import { writeSyntheticTranscriptCorpus } from '../../src/main/ai-vault-search/session-search-synthetic-corpus'
import { sessionCandidate } from '../../src/main/ai-vault-search/session-search-transcript-fixtures'
import SyncDatabase from '../../src/main/sqlite/sync-database'

// The cost model owed to the two-FTS-table decision. Everything runs through the
// real transcript reader and SessionSearchStore over a synthetic corpus, so the
// numbers include tokenization, the identifier shadow column and both FTS tables.
// Never point this at a real transcript tree.

/**
 * How long the longest single transaction held the process.
 *
 * With one transaction per file that is the whole stall a file costs, so it is
 * the number the commit ceiling exists to bound. Measured by wrapping `exec`,
 * because the writer's transactions are the only ones this benchmark runs.
 */
function recordTransactionDurations(durations: number[]): () => void {
  const exec = SyncDatabase.prototype.exec
  let started = 0
  SyncDatabase.prototype.exec = function (this: SyncDatabase, sql: string): void {
    if (sql === 'BEGIN IMMEDIATE') {
      started = performance.now()
    }
    exec.call(this, sql)
    if (sql === 'COMMIT' && started > 0) {
      durations.push(performance.now() - started)
      started = 0
    }
  }
  return () => {
    SyncDatabase.prototype.exec = exec
  }
}

/** The writer commits synchronously, so a peer chain samples the gap each read leaves. */
async function sampleLoopStalls(running: () => boolean, stalls: number[]): Promise<void> {
  let previous = performance.now()
  while (running()) {
    await yieldToEventLoop()
    const now = performance.now()
    stalls.push(now - previous)
    previous = now
  }
}

function tableBytes(db: SyncDatabase): Record<string, number> {
  const rows = db.prepare('SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name').all() as {
    name: string
    bytes: number
  }[]
  const group = (prefix: string): number =>
    rows
      .filter((row) => row.name === prefix || row.name.startsWith(`${prefix}_`))
      .reduce((sum, row) => sum + row.bytes, 0)
  return {
    messagesFts: group('messages_fts'),
    conversationFts: group('conversation_fts'),
    messages: group('messages') - group('messages_fts'),
    sessions: group('sessions'),
    total: rows.reduce((sum, row) => sum + row.bytes, 0)
  }
}

const corpus = await writeSyntheticTranscriptCorpus()
const indexPath = join(corpus.root, 'index.sqlite')
try {
  const errors: unknown[] = []
  const store = new SessionSearchStore(indexPath, (error) => errors.push(error))
  const unregister = registerSessionSearchIndexConsumer(store)
  const stalls: number[] = []
  const transactions: number[] = []
  const restoreExec = recordTransactionDurations(transactions)
  let indexing = true
  try {
    const stats = createSessionParseStats()
    const started = performance.now()
    const sampler = sampleLoopStalls(() => indexing, stalls)
    for (const path of corpus.files) {
      await parseAgentSessionFileCached(
        await sessionCandidate('claude', path),
        process.platform,
        stats
      )
    }
    indexing = false
    await sampler
    restoreExec()
    const rebuildMs = performance.now() - started
    assert.deepEqual(errors, [])

    const reader = new SyncDatabase(indexPath, { readonly: true })
    try {
      const rows = (
        reader.prepare('SELECT count(*) AS n FROM messages').get() as {
          n: number
        }
      ).n
      const sessions = (
        reader.prepare('SELECT count(*) AS n FROM sessions').get() as {
          n: number
        }
      ).n
      assert.equal(sessions, corpus.files.length)
      const bytes = tableBytes(reader)
      const perMb = (value: number): number =>
        Math.round((value / (corpus.transcriptBytes / (1024 * 1024))) * 10) / 10
      const fileBytes = (await stat(indexPath)).size
      stalls.sort((a, b) => a - b)
      transactions.sort((a, b) => a - b)
      console.log(
        JSON.stringify(
          {
            platform: process.platform,
            node: process.version,
            transcriptMb: Math.round((corpus.transcriptBytes / (1024 * 1024)) * 100) / 100,
            sessions,
            rows,
            rebuildMs: Math.round(rebuildMs),
            rowsPerSecond: Math.round(rows / (rebuildMs / 1000)),
            transcriptMbPerSecond:
              Math.round((corpus.transcriptBytes / (1024 * 1024) / (rebuildMs / 1000)) * 100) / 100,
            bytesPerTranscriptMb: {
              messagesFts: perMb(bytes.messagesFts),
              conversationFts: perMb(bytes.conversationFts),
              messages: perMb(bytes.messages),
              sessions: perMb(bytes.sessions),
              total: perMb(bytes.total)
            },
            writeAmplification: Math.round((bytes.total / corpus.transcriptBytes) * 100) / 100,
            fileWriteAmplification: Math.round((fileBytes / corpus.transcriptBytes) * 100) / 100,
            transactions: transactions.length,
            maxTransactionMs: Math.round((transactions.at(-1) ?? 0) * 100) / 100,
            maxLoopStallMs: Math.round(stalls.at(-1) ?? 0),
            p95LoopStallMs: Math.round(stalls[Math.floor(stalls.length * 0.95)] ?? 0),
            loopStallSamples: stalls.length,
            parseStats: stats
          },
          null,
          2
        )
      )
    } finally {
      reader.close()
    }
  } finally {
    indexing = false
    restoreExec()
    unregister()
    resetTranscriptConsumersForTests()
    resetSessionParseCacheForTests()
    store.close()
  }
} finally {
  await rm(corpus.root, { recursive: true, force: true })
}

// Phase two: one transcript far larger than any real one, to price the ceiling
// that decides whether a file commits once or in chunks.
const largeTurns = Number(process.env.ORCA_SEARCH_BENCH_LARGE_TURNS ?? 23_000)
const large = await writeSyntheticTranscriptCorpus({
  sessions: 1,
  turnsPerSession: largeTurns,
  seed: 2
})
const largeIndexPath = join(large.root, 'index.sqlite')
try {
  const errors: unknown[] = []
  const store = new SessionSearchStore(largeIndexPath, (error) => errors.push(error))
  const unregister = registerSessionSearchIndexConsumer(store)
  const transactions: number[] = []
  const restoreExec = recordTransactionDurations(transactions)
  try {
    const stats = createSessionParseStats()
    const started = performance.now()
    await parseAgentSessionFileCached(
      await sessionCandidate('claude', large.files[0]!),
      process.platform,
      stats
    )
    const indexMs = performance.now() - started
    restoreExec()
    assert.deepEqual(errors, [])
    transactions.sort((a, b) => a - b)
    console.log(
      JSON.stringify(
        {
          phase: 'single-large-file',
          transcriptMb: Math.round((large.transcriptBytes / (1024 * 1024)) * 100) / 100,
          indexMs: Math.round(indexMs),
          transactions: transactions.length,
          maxTransactionMs: Math.round(transactions.at(-1) ?? 0),
          indexMb: Math.round(((await stat(largeIndexPath)).size / (1024 * 1024)) * 100) / 100
        },
        null,
        2
      )
    )
  } finally {
    restoreExec()
    unregister()
    resetTranscriptConsumersForTests()
    resetSessionParseCacheForTests()
    store.close()
  }
} finally {
  await rm(large.root, { recursive: true, force: true })
}
