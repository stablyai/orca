import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import {
  syntheticCandidate,
  syntheticSession,
  userMessages
} from '../../src/main/ai-vault-search/session-search-index-test-fixture'
import { SessionSearchStore } from '../../src/main/ai-vault-search/session-search-store'
import SyncDatabase from '../../src/main/sqlite/sync-database'

// Bundle with esbuild --bundle --platform=node, then run on the host under test.
// Every mode seeds through SessionSearchStore so the three arms are comparable;
// only `whole-file` leaves the shipped path, because it is the baseline the
// batched purge exists to replace.

const ROWS = 60_000

/** The purge yields with `setImmediate` between chunks, so a peer chain samples each gap. */
async function sampleLoopStalls(running: () => boolean, intervals: number[]): Promise<void> {
  let previous = performance.now()
  while (running()) {
    await yieldToEventLoop()
    const now = performance.now()
    intervals.push(now - previous)
    previous = now
  }
}

/** What a search would still return: rows whose session row is still there. */
function visibleRows(db: SyncDatabase): number {
  return (
    db
      .prepare(`SELECT count(*) AS n FROM messages m JOIN sessions s ON s.id = m.session_row_id`)
      .get() as { n: number }
  ).n
}

const root = await mkdtemp(join(tmpdir(), 'orca-search-retention-bench-'))
try {
  for (const mode of ['whole-file', 'batched', 'batched-pinned-reader']) {
    const path = join(root, `${mode}.sqlite`)
    const errors: unknown[] = []
    const store = new SessionSearchStore(path, (error) => errors.push(error))
    let reader: SyncDatabase | null = null
    try {
      const write = store.beginWrite(syntheticCandidate(), 'replace', 0)!
      for (const message of userMessages(
        'synthetic benchmark needle repeated context for a representative coding conversation with commands and paths src/example.ts',
        ROWS
      )) {
        write.add(message)
      }
      assert.equal(
        write.commit({
          session: syntheticSession(),
          byteOffset: 4096,
          incomplete: false
        }),
        true
      )
      assert.deepEqual(errors, [])
      // Truncating first is what makes walBytes below the purge's own growth.
      const checkpoint = new SyncDatabase(path)
      checkpoint.pragma('wal_checkpoint(TRUNCATE)')
      checkpoint.close()
      if (mode === 'batched-pinned-reader') {
        reader = new SyncDatabase(path, { readonly: true })
        reader.exec('BEGIN')
        reader.prepare('SELECT count(*) FROM messages').get()
      }
      const probe = new SyncDatabase(path, { readonly: true })
      const intervals: number[] = []
      const started = performance.now()
      if (mode === 'whole-file') {
        const raw = new SyncDatabase(path)
        try {
          raw.exec('BEGIN IMMEDIATE')
          const ids = raw.prepare('SELECT id FROM messages').all() as {
            id: number
          }[]
          for (const { id } of ids) {
            raw.prepare('DELETE FROM messages_fts WHERE rowid=?').run(id)
          }
          raw.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM files; COMMIT')
        } finally {
          raw.close()
        }
        intervals.push(performance.now() - started)
      } else {
        let purging = true
        const purge = store.purgeOlderThan(Date.now() + 60_000)
        // Hiding is immediate: cutting the session loose from its file is the
        // first transaction, so a read one turn in already sees nothing, long
        // before the rows are gone.
        const hiddenEarly = yieldToEventLoop().then(() => visibleRows(probe))
        const sampler = sampleLoopStalls(() => purging, intervals)
        await purge
        purging = false
        await sampler
        assert.equal(await hiddenEarly, 0)
        assert.deepEqual(errors, [])
      }
      const wallMs = performance.now() - started
      probe.close()
      reader?.exec('COMMIT')
      reader?.close()
      reader = null
      const after = new SyncDatabase(path, { readonly: true })
      try {
        for (const table of ['messages_fts']) {
          assert.equal(
            (
              after.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
                n: number
              }
            ).n,
            0
          )
        }
      } finally {
        after.close()
      }
      const walBytes = (await stat(`${path}-wal`)).size
      intervals.sort((a, b) => a - b)
      console.log(
        JSON.stringify({
          mode,
          platform: process.platform,
          node: process.version,
          rows: ROWS,
          wallMs: Math.round(wallMs),
          samples: intervals.length,
          maxStepMs: Math.round(intervals.at(-1) ?? 0),
          p95StepMs: Math.round(intervals[Math.floor(intervals.length * 0.95)] ?? 0),
          walBytes
        })
      )
    } finally {
      reader?.close()
      store.close()
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
