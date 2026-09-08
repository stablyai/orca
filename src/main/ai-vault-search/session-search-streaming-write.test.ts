import { expect, it } from 'vitest'
import {
  captureSessionSearchMessage,
  checkpointSessionSearchCapture
} from '../ai-vault/session-search-capture'
import { captureIndexedSessionParse } from '../ai-vault/session-search-indexed-parse'
import { SessionSearchIndexWriter } from './session-search-index-writer'
import { SessionSearchStore } from './session-search-store'
import {
  openSessionSearchIndexFile,
  stagedWriteUpdate
} from './session-search-staged-write-test-fixture'

it.each(['publish', 'reject', 'throw', 'cancel'] as const)(
  'streams capture with atomic %s',
  async (outcome) => {
    const index = await openSessionSearchIndexFile('ss-streaming')
    const store = new SessionSearchStore(index.path)
    const writer = new SessionSearchIndexWriter(index.db)
    const original = stagedWriteUpdate('oldneedle', 1)
    const replacement = stagedWriteUpdate('newneedle', 600)
    let active = true
    try {
      await writer.apply(original)
      const parse = captureIndexedSessionParse(
        {
          indexedFile: () => null,
          markStale: () => {},
          apply: async (update) => {
            await writer.apply(update, { active: () => active, available: () => true })
          }
        },
        replacement,
        async () => {
          for (let i = 0; i < 600; i++) {
            captureSessionSearchMessage({ role: 'user', text: 'newneedle', timestamp: null })
            await checkpointSessionSearchCapture()
            if (i === 400) {
              expect(
                Number(
                  (index.db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n
                )
              ).toBeGreaterThan(128)
              expect(store.search({ query: 'newneedle' }).hits).toHaveLength(0)
              expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(1)
              if (outcome === 'throw') {
                throw new Error('synthetic parse failure')
              }
              if (outcome === 'cancel') {
                active = false
              }
            }
          }
          return {
            value: 'parsed',
            session: outcome === 'reject' ? null : replacement.session,
            byteOffset: 99
          }
        }
      )
      if (outcome === 'throw') {
        await expect(parse).rejects.toThrow('synthetic parse failure')
      } else {
        expect(await parse).toBe('parsed')
      }
      expect(store.search({ query: 'newneedle' }).hits).toHaveLength(outcome === 'publish' ? 1 : 0)
      expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(
        outcome === 'throw' || outcome === 'cancel' ? 1 : 0
      )
      expect(writer.indexedFile(original.candidate.file.path, null)?.byteOffset).toBe(
        outcome === 'publish' || outcome === 'reject' ? 99 : 1
      )
      if (outcome === 'publish') {
        expect(store.search({ query: 'newneedle' }).hits[0].title).toBe('newneedle')
      }
      await store.purgeOlderThan(null)
      expect(index.db.prepare('SELECT id FROM search_write_batches').all()).toHaveLength(0)
    } finally {
      store.close()
      await index.close()
    }
  }
)

it('waits for final metadata after the last message without mutating the write', async () => {
  const index = await openSessionSearchIndexFile('ss-streaming-final')
  const store = new SessionSearchStore(index.path)
  const writer = new SessionSearchIndexWriter(index.db)
  const replacement = stagedWriteUpdate('finaltitle', 1)
  const { promise: result, resolve } = Promise.withResolvers<{
    session: typeof replacement.session
    byteOffset: number
  }>()
  try {
    await writer.apply(stagedWriteUpdate('oldneedle', 1))
    let drained = false
    const write = Object.freeze({
      candidate: replacement.candidate,
      mode: replacement.mode,
      previousByteOffset: replacement.previousByteOffset,
      result,
      messages: (async function* () {
        yield { role: 'user' as const, text: 'newneedle', timestamp: null }
        drained = true
      })()
    })
    const applied = writer.apply(write)
    await expect.poll(() => drained).toBe(true)
    expect(store.search({ query: 'newneedle' }).hits).toHaveLength(0)
    expect(writer.indexedFile('synthetic-transcript', null)?.byteOffset).toBe(1)
    resolve({ session: replacement.session, byteOffset: 99 })
    expect(await applied).toBe(true)
    expect(store.search({ query: 'newneedle' }).hits[0].title).toBe('finaltitle')
    expect(writer.indexedFile('synthetic-transcript', null)?.byteOffset).toBe(99)
  } finally {
    resolve({ session: null, byteOffset: 0 })
    store.close()
    await index.close()
  }
})
