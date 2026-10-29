import { expect, it } from 'vitest'
import { SessionSearchIndexWriter } from './session-search-index-writer'
import {
  openSessionSearchIndexFile,
  syntheticCandidate,
  syntheticSession
} from './session-search-index-test-fixture'

function collectHeap(): number {
  if (!globalThis.gc) {
    throw new Error('Run this regression with --expose-gc')
  }
  void /reset/.test('reset')
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

it('keeps an unidentified transcript private without retaining its entire text in the heap', async () => {
  const index = await openSessionSearchIndexFile('ss-anonymous-memory')
  const writer = new SessionSearchIndexWriter(index.db, 64 * 1024)
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0)
  if (!write) {
    throw new Error('expected a write')
  }
  try {
    const baseline = collectHeap()
    for (let i = 0; i < 32; i++) {
      write.add({ role: 'assistant', text: `${i} ${'word '.repeat(200_000)}`, timestamp: null })
    }
    const retainedBytes = collectHeap() - baseline
    expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()?.n).toBe(0)
    expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()?.n).toBe(0)
    expect(retainedBytes).toBeLessThan(8 * 1024 * 1024)
    expect(
      write.commit({ session: syntheticSession(), byteOffset: 32_000_000, incomplete: false })
    ).toBe(true)
    const stored = index.db
      .prepare('SELECT sum(length(assistant_text)) AS characters FROM messages_fts')
      .get()
    expect(stored?.characters).toBe(32_000_086)
  } finally {
    write.discard()
    writer.close()
    await index.close()
  }
})
