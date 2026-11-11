import './worker/session-search-worker.test-fixture'
import { appendFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { FakeWatcherChild } from '../ipc/filesystem/watcher-process/parcel-watcher-process-test-child'
import { SessionSearchIndexer } from './indexing/session-search-indexer'
import {
  claudeLines,
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript
} from './indexing/session-search-indexer-test-fixture'

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('./session-search-watcher.test-fixture', () => ({
  notifySessionSearchFileChange: () => undefined
}))
vi.mock('node:child_process', async (original) => ({ ...(await original<object>()), fork }))
vi.mock('./session-search-filesystem', () => ({
  sessionSearchRequiresPolling: async () => false
}))

it('keeps indexing after a native crawl never becomes ready and retires its child', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-pending-watch')
  const path = join(harness.claudeProjectDir, 'pending.jsonl')
  const clock = new FakeSessionSearchClock()
  let crawling = false
  let nativeRoot: string
  let stalledChild: FakeWatcherChild | undefined
  const children: FakeWatcherChild[] = []
  fork.mockImplementation(() => {
    const child = new FakeWatcherChild()
    children.push(child)
    child.send.mockImplementation((message) => {
      child.sent.push(message)
      queueMicrotask(() => {
        if (message.op === 'subscribe') {
          if (message.dir === nativeRoot) {
            crawling = true
            stalledChild = child
            child.emit('message', { op: 'subscribe-started', id: message.id })
          } else {
            child.emit('message', { op: 'subscribed', id: message.id })
          }
        } else if (message.op === 'cancel-subscribe') {
          child.emit('message', { op: 'cancel-requires-restart', id: message.id })
        } else if (message.op === 'unsubscribe') {
          child.emit('message', { op: 'unsubscribed', id: message.id })
        }
      })
      return true
    })
    child.kill.mockImplementation(() => {
      child.connected = false
      queueMicrotask(() => child.emit('exit', 0, null))
      return true
    })
    return child
  })
  vi.stubEnv('VITEST', '')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock,
    watcherEntryPath: import.meta.filename
  })
  try {
    await writeClaudeTranscript(path, ['beforepressure'], 'pending')
    nativeRoot = await realpath(harness.roots.claudeProjectsDir!)
    const start = subject.start()
    await vi.waitFor(() => expect(crawling).toBe(true))
    await vi.advanceTimersByTimeAsync(60_000)
    await start
    expect(subject.status().filesIndexed).toBe(1)
    expect(stalledChild?.connected).toBe(false)

    await appendFile(path, `${claudeLines(['afterpressure'], 'pending', 10).join('\n')}\n`)
    clock.advance(20_000)
    await subject.settled()
    expect(
      harness.read((db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'afterpressure'"
          )
          .get()
      )
    ).toEqual({ n: 2 })
  } finally {
    await subject.close()
    expect(children.every((child) => !child.connected)).toBe(true)
    vi.useRealTimers()
    vi.unstubAllEnvs()
    fork.mockReset()
    await harness.cleanup()
  }
})
