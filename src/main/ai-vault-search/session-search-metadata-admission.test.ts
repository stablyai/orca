import './session-search-worker.test-fixture'
import { notifySessionSearchFileChange } from './session-search-watcher.test-fixture'
import { mkdir, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as parser from '../ai-vault/parse-cache/session-scanner-parse-cache'
import * as databaseReader from '../ai-vault/scanners/opencode/sqlite/session-scanner-opencode-sqlite-open'
import { resetDevinSessionsIndexCacheForTests } from '../ai-vault/scanners/devin/session-scanner-devin-db'
import {
  writeAntigravityHistory,
  writeAntigravityTranscript
} from '../ai-vault/session-scanner-test-fixtures'
import SyncDatabase from '../sqlite/sync-database'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

it('does not add a database-only Devin search wake and still enriches an admitted transcript read', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-devin-admission')
  const clock = new FakeSessionSearchClock()
  const root = harness.roots.devinTranscriptsDir!
  const path = join(root, 'shown.json')
  const dbPath = join(dirname(root), 'sessions.db')
  await mkdir(root, { recursive: true })
  const db = new SyncDatabase(dbPath)
  db.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, hidden INTEGER); INSERT INTO sessions VALUES ('shown', 'Original title', 0)"
  )
  const write = (text: string) =>
    writeFile(
      path,
      JSON.stringify({ session_id: 'shown', steps: [{ source: 'user', message: text }] })
    )
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock
  })
  const reads = vi.spyOn(parser, 'parseAgentSessionFileCached')
  const accessor = vi.spyOn(databaseReader, 'readOpenCodeDatabase')
  try {
    await write('originaldevinneedle')
    await subject.start()
    reads.mockClear()
    accessor.mockClear()
    db.exec("UPDATE sessions SET title='Changed title'")
    const previous = await stat(dbPath)
    await utimes(dbPath, new Date(previous.mtimeMs + 1000), new Date(previous.mtimeMs + 1000))
    notifySessionSearchFileChange(dbPath)
    clock.advance(20000)
    await subject.settled()
    expect(reads).not.toHaveBeenCalled()
    expect(accessor).not.toHaveBeenCalled()
    expect(
      harness.read((db) => db.prepare("SELECT title FROM sessions WHERE session_id='shown'").get())
    ).toEqual({ title: 'Original title' })
    await write('changeddevinneedle')
    notifySessionSearchFileChange(path)
    clock.advance(20000)
    await subject.settled()
    expect(
      harness.read((db) => db.prepare("SELECT title FROM sessions WHERE session_id='shown'").get())
    ).toEqual({ title: 'Changed title' })
    expect(
      harness.read((db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'changeddevinneedle'"
          )
          .get()
      )
    ).toEqual({ n: 1 })
  } finally {
    reads.mockRestore()
    accessor.mockRestore()
    db.close()
    resetDevinSessionsIndexCacheForTests()
    await subject.close()
    await harness.cleanup()
  }
})

it('does not fan out search reads for history metadata outside the Antigravity search parser', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-history-admission')
  const clock = new FakeSessionSearchClock()
  const root = harness.roots.antigravityBrainDir!
  const id = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock
  })
  const reads = vi.spyOn(parser, 'parseAgentSessionFileCached')
  try {
    const path = await writeAntigravityTranscript(root, id, [
      {
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-07-15T11:39:10.000Z',
        content: '<USER_REQUEST>historyadmissionneedle</USER_REQUEST>'
      }
    ])
    await subject.start()
    reads.mockClear()
    await writeAntigravityHistory(root, [
      { display: 'historyadmissionneedle', timestamp: 1784115550100, workspace: '/repo/changed' }
    ])
    notifySessionSearchFileChange(join(dirname(root), 'history.jsonl'))
    clock.advance(20000)
    await subject.settled()
    expect(reads).not.toHaveBeenCalled()
    expect(harness.read((db) => db.prepare('SELECT cwd FROM sessions').get())).toEqual({
      cwd: null
    })
    await writeFile(
      path,
      `${JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-07-15T11:39:10.000Z', content: '<USER_REQUEST>changedhistoryneedle</USER_REQUEST>' })}\n`
    )
    notifySessionSearchFileChange(path)
    clock.advance(20000)
    await subject.settled()
    expect(
      harness.read((db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'changedhistoryneedle'"
          )
          .get()
      )
    ).toEqual({ n: 1 })
  } finally {
    reads.mockRestore()
    await subject.close()
    await harness.cleanup()
  }
})
