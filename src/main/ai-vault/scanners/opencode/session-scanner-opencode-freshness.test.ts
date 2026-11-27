import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { discoverOpenCodeSessions } from './sqlite/session-scanner-opencode-sqlite-discovery'
import { parseAgentSessionFileCached } from '../../parse-cache/session-scanner-parse-cache'
import { resetSessionParseCacheForTests } from '../../parse-cache/session-parse-cache-store'
import {
  flushSessionParseCachePersist,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests
} from '../../parse-cache/session-parse-cache-persistence'
import type { SessionFileCandidate } from '../../session-scanner-types'
import { SessionSearchStore } from '../../../ai-vault-search/storage/session-search-store'
import { runSessionSearchIndexPass } from '../../../ai-vault-search/indexing/session-search-index-pass'
import { registerSessionSearchIndexConsumer } from '../../../ai-vault-search/indexing/session-search-index-consumer'

it('refreshes History and search when only legacy OpenCode part files change', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-opencode-freshness-')))
  const storage = join(root, 'storage')
  const path = join(storage, 'session', 'project', 'ses_saved.json')
  const put = async (file: string, content: unknown): Promise<void> => {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(content))
  }
  const cacheOptions = { filePath: join(root, 'session-parse-cache.json'), appVersion: 'test' }
  let store = new SessionSearchStore(join(root, 'search.sqlite'))
  let unregister = registerSessionSearchIndexConsumer(store)
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  initSessionParseCachePersistence(cacheOptions)
  const candidate = async (): Promise<SessionFileCandidate> => {
    const discovery = await discoverOpenCodeSessions({
      storageDir: storage,
      dbPaths: [],
      limitPerAgent: 10,
      issues: []
    })
    const file = discovery.files[0]
    if (!file) {
      throw new Error('Fixture session was not discovered')
    }
    return { agent: 'opencode', file, codexHome: null }
  }
  const index = async (source: SessionFileCandidate): Promise<void> => {
    await runSessionSearchIndexPass(store, [source], {
      rows: new Map(store.files().map((row) => [row.path, row]))
    })
  }
  const matches = (query: string): unknown =>
    store.connection
      .prepare(`SELECT count(*) AS count FROM messages_fts
        JOIN messages ON messages.id = messages_fts.rowid
        JOIN sessions ON sessions.id = messages.session_row_id
        WHERE messages_fts MATCH ?`)
      .get(query)?.count
  try {
    await put(path, {
      id: 'ses_saved',
      title: 'Fixture',
      directory: root,
      time: { created: 1784109600000, updated: 1784109600000 }
    })
    for (const [id, role] of [
      ['msg_user', 'user'],
      ['msg_assistant', 'assistant']
    ]) {
      await put(join(storage, 'message', 'ses_saved', `${id}.json`), {
        id,
        role,
        sessionID: 'ses_saved',
        time: { created: 1784109600000 }
      })
    }
    const userPart = join(storage, 'part', 'msg_user', 'prt_01.json')
    const assistantPart = join(storage, 'part', 'msg_assistant', 'prt_01.json')
    await put(userPart, { id: 'prt_01', type: 'text', text: 'Summarize the build.' })
    await put(assistantPart, { id: 'prt_01', type: 'text', text: 'draftquery' })
    const before = await candidate()
    await index(before)
    expect(
      (await parseAgentSessionFileCached(before, process.platform))?.previewMessages.find(
        (message) => message.role === 'assistant'
      )?.text
    ).toBe('draftquery')
    const sessionStat = await stat(path)
    await flushSessionParseCachePersist()
    unregister()
    store.close()
    resetSessionParseCacheForTests()
    resetSessionParseCachePersistenceForTests()
    initSessionParseCachePersistence(cacheOptions)
    store = new SessionSearchStore(join(root, 'search.sqlite'))
    unregister = registerSessionSearchIndexConsumer(store)
    expect(store.coversTranscript(await candidate())).toBe(true)
    expect(matches('draftquery')).toBe(1)

    await put(assistantPart, { id: 'prt_01', type: 'text', text: 'finalquery' })
    const after = await candidate()
    expect([after.file.mtimeMs, after.file.sizeBytes]).toEqual([
      sessionStat.mtimeMs,
      sessionStat.size
    ])
    expect
      .soft(
        (await parseAgentSessionFileCached(after, process.platform))?.previewMessages.find(
          (message) => message.role === 'assistant'
        )?.text
      )
      .toBe('finalquery')
    await index(after)
    expect.soft(matches('finalquery')).toBe(1)

    // A new part revision must get a fresh retry budget even when the parent is unchanged.
    for (let attempt = 0; attempt < 3; attempt++) {
      store.setFileState(path, 'failed', after.file.mtimeMs, after.file.dependencySignature)
    }
    await put(assistantPart, { id: 'prt_01', type: 'text', text: 'recoveredquery' })
    const recovered = await candidate()
    store.setFileState(path, 'failed', recovered.file.mtimeMs, recovered.file.dependencySignature)
    expect.soft(store.files()[0]?.failCount).toBe(1)
    await index(recovered)
    expect.soft(matches('recoveredquery')).toBe(1)
  } finally {
    unregister()
    store.close()
    resetSessionParseCacheForTests()
    resetSessionParseCachePersistenceForTests()
    await rm(root, { recursive: true, force: true })
  }
})
