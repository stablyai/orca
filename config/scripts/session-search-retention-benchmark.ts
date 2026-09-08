import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import SyncDatabase from '../../src/main/sqlite/sync-database'
import { SessionSearchStore } from '../../src/main/ai-vault-search/session-search-store'
import { stagedWriteUpdate } from '../../src/main/ai-vault-search/session-search-staged-write-test-fixture'

// Bundle with esbuild --bundle --platform=node, then run on the host under test.
// Every mode seeds through SessionSearchStore so the three arms are comparable;
// only `whole-file` leaves the shipped path, because it is the baseline the
// batched purge exists to replace.

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

const root = await mkdtemp(join(tmpdir(), 'orca-search-retention-bench-'))
try {
  for (const mode of ['whole-file', 'batched', 'batched-pinned-reader']) {
    const path = join(root, `${mode}.sqlite`)
    const errors: unknown[] = []
    const store = new SessionSearchStore(path, (error) => errors.push(error))
    let reader: SyncDatabase | null = null
    try {
      await store.apply(
        stagedWriteUpdate(
          'synthetic benchmark needle repeated context for a representative coding conversation with commands and paths src/example.ts',
          60000
        )
      )
      assert.deepEqual(errors, [])
      assert.equal(store.search({ query: 'needle' }).hits.length, 1)
      // Truncating first is what makes walBytes below the purge's own growth.
      const checkpoint = new SyncDatabase(path)
      checkpoint.pragma('wal_checkpoint(TRUNCATE)')
      checkpoint.close()
      if (mode === 'batched-pinned-reader') {
        reader = new SyncDatabase(path, { readonly: true })
        reader.exec('BEGIN')
        reader.prepare('SELECT count(*) FROM messages').get()
      }
      const intervals: number[] = []
      const started = performance.now()
      if (mode === 'whole-file') {
        const raw = new SyncDatabase(path)
        try {
          raw.exec('BEGIN IMMEDIATE')
          const ids = raw.prepare('SELECT id FROM messages').all() as { id: number }[]
          for (const { id } of ids) {
            raw.prepare('DELETE FROM messages_fts WHERE rowid=?').run(id)
            raw.prepare('DELETE FROM conversation_fts WHERE rowid=?').run(id)
          }
          raw.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM files; COMMIT')
        } finally {
          raw.close()
        }
        intervals.push(performance.now() - started)
      } else {
        let purging = true
        const purge = store.purgeOlderThan(Date.now() + 60_000)
        // Hiding is immediate: the tombstone commits in the first chunk, so a read one
        // turn in already sees nothing, long before the rows are gone.
        const hiddenEarly = yieldToEventLoop().then(
          () => store.search({ query: 'needle' }).hits.length
        )
        const sampler = sampleLoopStalls(() => purging, intervals)
        await purge
        purging = false
        await sampler
        assert.equal(await hiddenEarly, 0)
        assert.deepEqual(errors, [])
      }
      const wallMs = performance.now() - started
      reader?.exec('COMMIT')
      reader?.close()
      reader = null
      const after = new SyncDatabase(path, { readonly: true })
      try {
        for (const table of ['messages_fts', 'conversation_fts']) {
          assert.equal(
            (after.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
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
          rows: 60000,
          wallMs,
          samples: intervals.length,
          maxStepMs: intervals.at(-1),
          p95StepMs: intervals[Math.floor(intervals.length * 0.95)],
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
