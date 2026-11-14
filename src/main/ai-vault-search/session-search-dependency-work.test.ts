import './worker/session-search-worker.test-fixture'
import { notifySessionSearchFileChange } from './session-search-watcher.test-fixture'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { zstdCompressSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as filesystem from '../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import {
  codexFixture,
  CODEX_FIXTURE_SESSION_ID
} from '../ai-vault/scanners/codex/session-scanner-codex-fixtures'
import { SessionSearchWorkerClient } from './worker/session-search-worker-client'
import { SessionSearchIndexer } from './indexing/session-search-indexer'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness
} from './indexing/session-search-indexer-test-fixture'

it('updates an archived Codex title while retaining its neighboring conversation', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-archive-title')
  const clock = new FakeSessionSearchClock()
  const root = harness.roots.codexSessionsDir!
  const index = join(dirname(root), 'session_index.jsonl')
  const fixture = codexFixture()
  const neighbor = '019f0000-1111-7222-8333-000000000001'
  const subject = new SessionSearchIndexer({
    discoveryPolicy: 'event-led',
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock
  })
  const titles = () =>
    harness.read((db) =>
      db.prepare('SELECT session_id,title FROM sessions ORDER BY session_id').all()
    )
  try {
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, `${fixture.fileName}.zst`),
      zstdCompressSync(Buffer.from(`${fixture.seedLines.join('\n')}\n`))
    )
    await writeFile(
      join(root, fixture.fileName.replace(CODEX_FIXTURE_SESSION_ID, neighbor)),
      `${fixture.seedLines.join('\n').replaceAll(CODEX_FIXTURE_SESSION_ID, neighbor)}\n`
    )
    await writeFile(
      index,
      [
        { id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Original title' },
        { id: neighbor, thread_name: 'Original title' }
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join('')
    )
    await subject.start()
    expect(titles()).toEqual([
      { session_id: '019f0000-1111-7222-8333-000000000001', title: 'Original title' },
      { session_id: '019f0000-1111-7222-8333-444444444444', title: 'Original title' }
    ])
    await appendFile(
      index,
      `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Changed archive title' })}\n`
    )
    notifySessionSearchFileChange(index)
    clock.advance(20000)
    await subject.settled()
    expect(titles()).toEqual([
      { session_id: '019f0000-1111-7222-8333-000000000001', title: 'Original title' },
      { session_id: '019f0000-1111-7222-8333-444444444444', title: 'Changed archive title' }
    ])
    await writeFile(
      index,
      [
        { id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Replacement title' },
        { id: neighbor, thread_name: 'Replacement title' }
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join('')
    )
    notifySessionSearchFileChange(index)
    clock.advance(20000)
    await subject.settled()
    expect(titles()).toEqual([
      { session_id: '019f0000-1111-7222-8333-000000000001', title: 'Replacement title' },
      { session_id: '019f0000-1111-7222-8333-444444444444', title: 'Replacement title' }
    ])
  } finally {
    await subject.close()
    await harness.cleanup()
  }
})

it('settles a refused JSONL observer without losing its accepted title and wakes it on delivery', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-refused-title-index')
  const clock = new FakeSessionSearchClock()
  const root = harness.roots.codexSessionsDir!
  const index = join(dirname(root), 'session_index.jsonl')
  const fixture = codexFixture()
  const subject = new SessionSearchIndexer({
    discoveryPolicy: 'event-led',
    databasePath: harness.databasePath,
    roots: { ...harness.roots, kimiSessionsDir: join(harness.root, 'kimi-home', 'sessions') },
    historyDays: null,
    clock,
    fullSweepEveryCycles: 1000
  })
  const actual = filesystem.wslGatedStat
  let refused = false
  const probe = vi.spyOn(filesystem, 'wslGatedStat').mockImplementation((path, ...rest) => {
    if (refused && path === index) {
      return Promise.reject(
        Object.assign(new Error('fixture refused title index'), { code: 'EACCES' })
      )
    }
    return actual(path, ...rest)
  })
  try {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, fixture.fileName), `${fixture.seedLines.join('\n')}\n`)
    await writeFile(
      index,
      `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Accepted title' })}\n`
    )
    await subject.start()
    refused = true
    for (let cycle = 0; cycle < 4; cycle++) {
      clock.advance(20000)
      await subject.settled()
    }
    expect(subject.status().phase).toBe('current')
    expect(harness.read((db) => db.prepare('SELECT title FROM sessions').get())).toEqual({
      title: 'Accepted title'
    })
    refused = false
    await appendFile(
      index,
      `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Recovered title' })}\n`
    )
    notifySessionSearchFileChange(index)
    clock.advance(20000)
    await subject.settled()
    expect(harness.read((db) => db.prepare('SELECT title FROM sessions').get())).toEqual({
      title: 'Recovered title'
    })
    expect(subject.status().phase).toBe('current')
  } finally {
    probe.mockRestore()
    await subject.close()
    await harness.cleanup()
  }
})

it.each(['physical page', 'physical complete', 'dependency page'])(
  'rediscovers a returning root after retiring its %s',
  async (pause) => {
    const harness = await openSessionSearchIndexerHarness('ss-returning-source')
    const clock = new FakeSessionSearchClock()
    const root = harness.roots.codexSessionsDir!
    const index = join(dirname(root), 'session_index.jsonl')
    const fixture = codexFixture()
    const errors: unknown[] = []
    const subject = new SessionSearchIndexer({
      discoveryPolicy: 'event-led',
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock,
      onError: (error) => errors.push(error)
    })
    const request = SessionSearchWorkerClient.prototype.request
    let retiring = false
    let yielded = false
    const transport = vi
      .spyOn(SessionSearchWorkerClient.prototype, 'request')
      .mockImplementation(async function (this: SessionSearchWorkerClient, command) {
        const response = await request.call(this, command)
        if (
          retiring &&
          !yielded &&
          command.op === 'catalog' &&
          command.command.kind === 'release-scopes-page'
        ) {
          const physical = command.command.scope === `physical:codex:${root}`
          const shouldYield =
            pause === 'physical complete'
              ? physical && response.catalog?.count === 0
              : pause === 'physical page'
                ? physical && (response.catalog?.count ?? 0) > 0
                : command.command.scope === `dependency:codex:${root}:${dirname(root)}` &&
                  response.catalog?.count === 256
          if (shouldYield) {
            clock.costPerNowMs = 10000
            yielded = true
          }
        }
        return response
      })
    const title = () => harness.read((db) => db.prepare('SELECT title FROM sessions').all())
    const otherTitles = Array.from(
      { length: 300 },
      (_, id) =>
        `${JSON.stringify({
          id: `019f0000-1111-7222-8333-9${String(id).padStart(11, '0')}`,
          thread_name: 'Other title'
        })}\n`
    ).join('')
    try {
      await mkdir(root, { recursive: true })
      await writeFile(join(root, fixture.fileName), `${fixture.seedLines.join('\n')}\n`)
      await writeFile(
        index,
        `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Returning title' })}\n${otherTitles}`
      )
      await subject.start()
      expect(title()).toEqual([{ title: 'Returning title' }])
      harness.roots.codexSessionsDir = join(harness.root, 'replacement-sessions')
      retiring = true
      await subject.reconcile({ full: true })
      expect(yielded).toBe(true)
      retiring = false
      clock.costPerNowMs = 0
      harness.roots.codexSessionsDir = root
      await subject.reconcile({ full: true })
      await subject.reconcile()
      expect(title()).toEqual([{ title: 'Returning title' }])
      await writeFile(index, otherTitles)
      notifySessionSearchFileChange(index)
      clock.advance(20000)
      await subject.settled()
      expect(title()).toEqual([{ title: 'Returning title' }])
      await writeFile(
        index,
        `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Updated returning title' })}\n${otherTitles}`
      )
      notifySessionSearchFileChange(index)
      clock.advance(20000)
      await subject.settled()
      expect(title()).toEqual([{ title: 'Updated returning title' }])
      expect(subject.status().phase).toBe('current')
      expect(subject.status().filesFailed).toBe(0)
      expect(errors).toEqual([])
    } finally {
      transport.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)
