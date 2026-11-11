import { expect, it } from 'vitest'
import {
  addSyntheticSession,
  openSessionSearchHarness
} from '../query/session-search-engine-test-fixture'
import { readIndexGeneration } from './session-search-index-generation'
import '../query/session-search-page-cursor'
import { SessionSearchToolPurge } from './session-search-tool-purge'

it('purges legacy tool rows across batches while preserving conversations and raw generation fences', async () => {
  const index = await openSessionSearchHarness('ss-tool-purge')
  try {
    addSyntheticSession(index.db, { id: 1, text: 'userkept' })
    addSyntheticSession(index.db, { id: 2, role: 'assistant', text: 'assistantkept' })
    addSyntheticSession(index.db, { id: 3, role: 'tool', text: 'toolremoved', rows: 600 })
    const before = readIndexGeneration(index.db)
    expect(index.engine.search({ query: 'toolremoved' }).hits).toHaveLength(0)
    let messages = 602
    const errors: unknown[] = []
    const purge = new SessionSearchToolPurge(
      index.db,
      () => false,
      (delta) => {
        messages += delta
      },
      (error) => errors.push(error)
    )
    await purge.request()
    expect(errors).toEqual([])
    expect(index.engine.search({ query: 'toolremoved' }).hits).toEqual([])
    expect(index.engine.search({ query: 'userkept' }).hits[0]?.sessionId).toBe('1')
    expect(index.engine.search({ query: 'assistantkept' }).hits[0]?.sessionId).toBe('2')
    expect(messages).toBe(2)
    expect(readIndexGeneration(index.db)).toBeGreaterThan(before)
    addSyntheticSession(index.db, { id: 4, role: 'tool', text: 'newlegacytool' })
    await purge.request()
    expect(index.engine.search({ query: 'newlegacytool' }).hits).toEqual([])
  } finally {
    await index.close()
  }
})
