import './session-search-worker.test-fixture'
import {
  notifySessionSearchFileChange,
  notifySessionSearchOverflow
} from './session-search-watcher.test-fixture'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { zstdCompressSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as filesystem from '../native-chat/wsl-transcript-fs-access'
import {
  codexFixture,
  CODEX_FIXTURE_SESSION_ID
} from '../ai-vault/scanners/codex/session-scanner-codex-fixtures'
import { SessionSearchWorkerClient } from './session-search-worker-client'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

it.each([40, 400])(
  'bounds one title append independently of %s index records and transcript owners',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-title-input-work')
    const clock = new FakeSessionSearchClock()
    const root = harness.roots.codexSessionsDir!
    const index = join(dirname(root), 'session_index.jsonl')
    const fixture = codexFixture()
    const ids = Array.from(
      { length: population },
      (_, id) => `019f0000-1111-7222-8333-${String(id).padStart(12, '0')}`
    )
    const records = ids.map((id) => `${JSON.stringify({ id, thread_name: 'Original title' })}\n`)
    const subject = new SessionSearchIndexer({
      databasePath: harness.databasePath,
      roots: { ...harness.roots, kimiSessionsDir: join(harness.root, 'kimi-home', 'sessions') },
      historyDays: null,
      clock
    })
    const streams = vi.spyOn(filesystem, 'openTranscriptReadStream')
    const slices = vi.spyOn(filesystem, 'readTranscriptSlice')
    const traffic = vi.spyOn(SessionSearchWorkerClient.prototype, 'request')
    const transcripts = new Set<string>()
    try {
      await mkdir(root, { recursive: true })
      for (const id of ids) {
        const archived = id === ids[0]
        const path = join(
          root,
          fixture.fileName.replace(CODEX_FIXTURE_SESSION_ID, id) + (archived ? '.zst' : '')
        )
        transcripts.add(path)
        const text = `${fixture.seedLines.join('\n').replaceAll(CODEX_FIXTURE_SESSION_ID, id)}\n`
        await writeFile(path, archived ? zstdCompressSync(Buffer.from(text)) : text)
      }
      await writeFile(index, records.join(''))
      await subject.start()
      streams.mockClear()
      slices.mockClear()
      // Lost delivery must re-observe the input, not reread it or force every transcript.
      notifySessionSearchOverflow(dirname(root))
      clock.advance(20000)
      await subject.settled()
      expect(streams.mock.calls.filter(([path]) => path === index)).toHaveLength(0)
      expect(streams.mock.calls.filter(([path]) => transcripts.has(path))).toHaveLength(0)
      expect(slices.mock.calls.filter(([path]) => transcripts.has(path))).toHaveLength(0)
      const append = `${JSON.stringify({ id: ids[0], thread_name: 'Changed title' })}\n`
      const size = Buffer.byteLength(records.join('') + append)
      await appendFile(index, append)
      notifySessionSearchFileChange(index)
      clock.advance(20000)
      await subject.settled()
      const indexBytes =
        streams.mock.calls.reduce(
          (bytes, [path, options]) =>
            path !== index
              ? bytes
              : bytes + Math.max(0, (options?.end ?? size - 1) - (options?.start ?? 0) + 1),
          0
        ) +
        slices.mock.calls.reduce(
          (bytes, [path, , length]) => (path === index ? bytes + length : bytes),
          0
        )
      // Two independent consumers need the appended record plus one fixed continuity record each.
      expect(indexBytes).toBeLessThanOrEqual(
        2 * (Buffer.byteLength(append) + Buffer.byteLength(records[0]) + 1)
      )
      expect(streams.mock.calls.filter(([path]) => transcripts.has(path))).toHaveLength(0)
      expect(slices.mock.calls.filter(([path]) => transcripts.has(path))).toHaveLength(0)
      expect(
        harness.read((db) =>
          db.prepare("SELECT count(*) AS n FROM sessions WHERE title='Changed title'").get()
        )
      ).toEqual({ n: 1 })
      expect(
        harness.read((db) =>
          db.prepare("SELECT count(*) AS n FROM sessions WHERE title='Original title'").get()
        )
      ).toEqual({ n: population - 1 })
      traffic.mockClear()
      await writeFile(
        index,
        ids.map((id) => `${JSON.stringify({ id, thread_name: 'Replaced title' })}\n`).join('')
      )
      notifySessionSearchFileChange(index)
      clock.advance(20000)
      await subject.settled()
      expect(
        harness.read((db) =>
          db.prepare("SELECT count(*) AS n FROM sessions WHERE title='Replaced title'").get()
        )
      ).toEqual({ n: population })
      const firstRead = traffic.mock.calls.findIndex(
        ([command]) => command.op === 'work' && command.command.kind === 'next'
      )
      const fanout = traffic.mock.calls
        .slice(0, firstRead === -1 ? undefined : firstRead)
        .filter(
          ([command]) =>
            command.op === 'catalog' &&
            (command.command.scope.startsWith(`dependency:codex:${root}:`) ||
              command.command.scope.startsWith(`physical:codex:${root}`)) &&
            (command.command.kind === 'dependency-fanout' ||
              command.command.kind === 'dependency-deliver' ||
              command.command.kind === 'dirty-page' ||
              command.command.kind === 'frontier-set' ||
              command.command.kind === 'get' ||
              command.command.kind === 'put')
        )
      // Accepted changed keys, their reverse owners and physical observations each have one bounded page handoff, plus fixed source phases.
      expect(fanout.length).toBeLessThanOrEqual(40 + 12 * Math.ceil(population / 256))
    } finally {
      streams.mockRestore()
      slices.mockRestore()
      traffic.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)

it('settles a refused JSONL observer without losing its accepted title and wakes it on delivery', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-refused-title-index')
  const clock = new FakeSessionSearchClock()
  const root = harness.roots.codexSessionsDir!
  const index = join(dirname(root), 'session_index.jsonl')
  const fixture = codexFixture()
  const subject = new SessionSearchIndexer({
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
