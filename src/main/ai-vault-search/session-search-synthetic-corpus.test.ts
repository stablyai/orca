import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { SessionSearchStore } from './session-search-store'
import { writeSyntheticTranscriptCorpus } from './session-search-synthetic-corpus'
import { parseTranscript } from './session-search-transcript-fixtures'

it.each([Infinity, -Infinity, Number.NaN, -1, 1.5])(
  'rejects invalid corpus loop bounds: %s',
  async (value) => {
    for (const field of ['sessions', 'turnsPerSession', 'toolResultWords']) {
      await expect(writeSyntheticTranscriptCorpus({ [field]: value })).rejects.toThrow(RangeError)
    }
  }
)

it.each([0, 200, 2000])(
  'counts the indexed messages with %s tool words',
  async (toolResultWords) => {
    const corpus = await writeSyntheticTranscriptCorpus({
      sessions: 1,
      turnsPerSession: 1,
      toolResultWords
    })
    const store = new SessionSearchStore(join(corpus.root, 'index.sqlite'))
    const unregister = registerSessionSearchIndexConsumer(store)
    try {
      await parseTranscript(corpus.files[0]!)
      expect(corpus.messageCount).toBe(toolResultWords === 0 ? 3 : 4)
      expect(store.connection.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({
        n: corpus.messageCount
      })
    } finally {
      unregister()
      resetTranscriptConsumersForTests()
      resetSessionParseCacheForTests()
      store.close()
      await rm(corpus.root, { recursive: true, force: true })
    }
  }
)
