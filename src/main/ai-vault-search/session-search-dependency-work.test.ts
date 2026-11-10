import './session-search-worker.test-fixture'
import {
  notifySessionSearchFileChange,
  notifySessionSearchOverflow
} from './session-search-watcher.test-fixture'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as filesystem from '../native-chat/wsl-transcript-fs-access'
import * as parser from '../ai-vault/parse-cache/session-scanner-parse-cache'
import {
  codexFixture,
  CODEX_FIXTURE_SESSION_ID
} from '../ai-vault/scanners/codex/session-scanner-codex-fixtures'
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
    const reads = vi.spyOn(parser, 'parseAgentSessionFileCached')
    try {
      await mkdir(root, { recursive: true })
      for (const id of ids) {
        await writeFile(
          join(root, fixture.fileName.replace(CODEX_FIXTURE_SESSION_ID, id)),
          `${fixture.seedLines.join('\n').replaceAll(CODEX_FIXTURE_SESSION_ID, id)}\n`
        )
      }
      await writeFile(index, records.join(''))
      await subject.start()
      streams.mockClear()
      slices.mockClear()
      reads.mockClear()
      // Lost delivery must re-observe the input, not reread it or force every transcript.
      notifySessionSearchOverflow(dirname(root))
      clock.advance(20000)
      await subject.settled()
      expect(streams.mock.calls.filter(([path]) => path === index)).toHaveLength(0)
      expect(reads).not.toHaveBeenCalled()
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
      expect(reads).toHaveBeenCalledTimes(1)
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
    } finally {
      streams.mockRestore()
      slices.mockRestore()
      reads.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)
