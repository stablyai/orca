import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionSearchStore } from './session-search-store'
import { parseSearchCandidates } from './session-search-parse-candidates'
import { sessionCandidate } from './session-search-transcript-fixtures'
import { stagedWriteUpdate } from './session-search-staged-write-test-fixture'
import { registerSessionSearchIndexSink } from '../ai-vault/session-search-capture'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import * as sourceRead from '../native-chat/wsl-transcript-fs-access'

it('preserves published content and cursor when a whole-JSON refresh is canceled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ss-cancel-publish-'))
  const store = new SessionSearchStore(join(root, 'index.sqlite'))
  const held = Promise.withResolvers<void>()
  const reached = Promise.withResolvers<void>()
  let parsing: Promise<unknown> | undefined
  try {
    resetSessionParseCacheForTests()
    registerSessionSearchIndexSink(store)
    const path = join(root, 'gemini.json')
    const document = {
      sessionId: 'cancel-session',
      messages: [{ type: 'user', content: 'oldneedle' }]
    }
    await writeFile(path, JSON.stringify(document))
    await parseSearchCandidates(store, [await sessionCandidate('gemini', path)])
    const before = store.indexedFile(path, null)
    document.messages.push({ type: 'gemini', content: 'newneedle after refresh' })
    await writeFile(path, JSON.stringify(document))
    const candidate = await sessionCandidate('gemini', path)
    const read = sourceRead.wslGatedReadFile
    vi.spyOn(sourceRead, 'wslGatedReadFile').mockImplementationOnce(async (...args) => {
      const text = await read(...args)
      reached.resolve()
      await held.promise
      return text
    })
    const controller = new AbortController()
    parsing = parseSearchCandidates(store, [candidate], { signal: controller.signal }).catch(
      (error) => error
    )
    await reached.promise
    controller.abort()
    held.resolve()
    expect(await parsing).toMatchObject({ name: 'AbortError' })
    expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(1)
    expect(store.search({ query: 'newneedle' }).hits).toHaveLength(0)
    expect(store.indexedFile(path, null)).toEqual(before)
    expect(store.failures).toBe(0)
    resetSessionParseCacheForTests()
    await parseSearchCandidates(store, [candidate])
    expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(1)
    expect(store.search({ query: 'newneedle' }).hits).toHaveLength(1)
  } finally {
    held.resolve()
    await parsing
    vi.restoreAllMocks()
    registerSessionSearchIndexSink(null)
    store.close()
    resetSessionParseCacheForTests()
    await rm(root, { recursive: true, force: true })
  }
})

it('checks cancellation again before publishing fully consumed staged messages', async () => {
  const store = new SessionSearchStore(':memory:')
  const original = stagedWriteUpdate('oldneedle', 1)
  const replacement = stagedWriteUpdate('newneedle', 1)
  const result = Promise.withResolvers<{
    session: typeof replacement.session
    byteOffset: number
  }>()
  const consumed = Promise.withResolvers<void>()
  const controller = new AbortController()
  let pending: Promise<void> | undefined
  try {
    await store.apply(original)
    pending = store.apply({
      candidate: replacement.candidate,
      mode: 'replace',
      previousByteOffset: 0,
      signal: controller.signal,
      result: result.promise,
      messages: (async function* () {
        yield { role: 'user' as const, text: 'newneedle', timestamp: null }
        consumed.resolve()
      })()
    })
    await consumed.promise
    controller.abort()
    result.resolve({ session: replacement.session, byteOffset: 99 })
    await pending
    expect(store.search({ query: 'oldneedle' }).hits).toHaveLength(1)
    expect(store.search({ query: 'newneedle' }).hits).toHaveLength(0)
    expect(store.indexedFile(original.candidate.file.path, null)?.byteOffset).toBe(1)
    expect(store.failures).toBe(0)
  } finally {
    result.resolve({ session: null, byteOffset: 0 })
    await pending
    store.close()
  }
})
