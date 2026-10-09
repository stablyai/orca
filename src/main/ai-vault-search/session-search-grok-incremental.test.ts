import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { observeGrokHistory } from '../ai-vault/session-scanner-grok-resume'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { runSessionSearchIndexPass } from './session-search-index-pass'
import { SessionSearchStore } from './session-search-store'

it('indexes Grok history appends and skips unchanged scans across a restart', async () => {
  resetSessionParseCacheForTests()
  const root = await mkdtemp(join(tmpdir(), 'orca-grok-index-'))
  const summary = join(root, 'summary.json')
  const history = join(root, 'chat_history.jsonl')
  const database = join(root, 'index.sqlite')
  const errors: unknown[] = []
  let store = new SessionSearchStore(database, (error) => errors.push(error))
  let unregister = registerSessionSearchIndexConsumer(store)
  const record = (text: string): string => `${JSON.stringify({ type: 'user', content: text })}\n`
  async function pass() {
    const info = await stat(summary)
    const candidate = await observeGrokHistory({
      agent: 'grok',
      codexHome: null,
      file: {
        path: summary,
        mtimeMs: info.mtimeMs,
        modifiedAt: info.mtime.toISOString(),
        sizeBytes: info.size
      }
    })
    return runSessionSearchIndexPass(store, [candidate], {
      rows: new Map(store.files().map((row) => [row.path, row]))
    })
  }
  try {
    await writeFile(summary, JSON.stringify({ info: { id: 'session', cwd: '/repo' } }))
    await writeFile(history, record('Initial message '.repeat(50)))
    expect((await pass()).stats.fullParses).toBe(1)
    expect((await pass()).stats.bytesRead).toBe(0)
    const appended = record('New searchable turn')
    await appendFile(history, appended)
    expect((await pass()).stats).toMatchObject({
      incremental: 1,
      fullParses: 0,
      bytesRead: Buffer.byteLength(appended)
    })
    expect(store.stateCounts().messages).toBe(2)
    expect((await pass()).stats).toMatchObject({ incremental: 0, fullParses: 0 })
    unregister()
    store.close()
    resetSessionParseCacheForTests()
    store = new SessionSearchStore(database, (error) => errors.push(error))
    unregister = registerSessionSearchIndexConsumer(store)
    expect((await pass()).stats).toMatchObject({ fullParses: 0, bytesRead: 0 })
    expect(store.stateCounts().messages).toBe(2)
    expect(errors).toEqual([])
  } finally {
    unregister()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
