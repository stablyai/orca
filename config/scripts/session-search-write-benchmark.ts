import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { SessionSearchStore } from '../../src/main/ai-vault-search/session-search-store'
import { stagedWriteUpdate } from '../../src/main/ai-vault-search/session-search-staged-write-test-fixture'

// Bundle with esbuild --bundle --platform=node, then run on the host under test.
// Everything runs through SessionSearchStore, so the numbers include the query log,
// the post-write cleanup and the compaction that a real index pays for.

/**
 * Staging yields with `setImmediate` between chunks, so a peer chain samples the gap
 * each chunk leaves. Measuring from outside keeps the owner's own step hook untouched.
 */
async function sampleLoopStalls(running: () => boolean, stalls: number[]): Promise<void> {
  let previous = performance.now()
  while (running()) {
    await yieldToEventLoop()
    const now = performance.now()
    stalls.push(now - previous)
    previous = now
  }
}

const root = await mkdtemp(join(tmpdir(), 'orca-search-write-bench-'))
try {
  const path = join(root, 'index.sqlite')
  const errors: unknown[] = []
  const store = new SessionSearchStore(path, (error) => errors.push(error))
  try {
    for (const mode of ['replace', 'append', 'replace'] as const) {
      const update = stagedWriteUpdate(
        `benchmarkneedle ${'synthetic coding context src/example.ts '.repeat(5)}`,
        60000,
        mode
      )
      const stalls: number[] = []
      let writing = true
      const start = performance.now()
      const sampler = sampleLoopStalls(() => writing, stalls)
      await store.apply(update)
      writing = false
      await sampler
      const wallMs = performance.now() - start
      assert.deepEqual(errors, [])
      assert.equal(store.search({ query: 'benchmarkneedle' }).hits.length, 1)
      console.log(
        JSON.stringify({
          platform: process.platform,
          node: process.version,
          mode,
          rows: 60000,
          wallMs,
          maxLoopStallMs: Math.max(...stalls),
          samples: stalls.length,
          walBytes: (await stat(`${path}-wal`)).size
        })
      )
      // Drains the tombstones the write left and compacts, exactly as a live purge does.
      await store.purgeOlderThan(null)
    }
  } finally {
    store.close()
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
