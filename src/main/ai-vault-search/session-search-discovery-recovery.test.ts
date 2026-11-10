import './session-search-worker.test-fixture'
import {
  notifySessionSearchFileChange,
  notifySessionSearchOverflow
} from './session-search-watcher.test-fixture'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as filesystem from '../native-chat/wsl-transcript-fs-access'
import * as parser from '../ai-vault/parse-cache/session-scanner-parse-cache'
import * as policy from './session-search-filesystem'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  claudeLines
} from './session-search-indexer-test-fixture'

it.each([100, 1000])(
  'reads appended bytes after a delivered update to a recent %s-turn transcript',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-recent-append')
    const clock = new FakeSessionSearchClock()
    const path = join(harness.claudeProjectDir, 'active.jsonl')
    const subject = new SessionSearchIndexer({
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock
    })
    const reads = vi.spyOn(parser, 'parseAgentSessionFileCached')
    try {
      await writeClaudeTranscript(
        path,
        Array.from({ length: population }, () => 'archivedbody'),
        'active'
      )
      await subject.start()
      for (let cycle = 0; cycle < 3; cycle++) {
        reads.mockClear()
        const append = `${claudeLines(['appendedneedle'], 'active', population * 2 + cycle * 2).join('\n')}\n`
        await appendFile(path, append)
        notifySessionSearchFileChange(path)
        clock.advance(20000)
        await subject.settled()
        const call = reads.mock.calls.find(([candidate]) => candidate.file.path === path)
        expect(call).toBeDefined()
        // The parser stream needs only appended records; its fixed continuity probe does not grow with history.
        expect(call?.[2]?.bytesRead).toBeLessThanOrEqual(Buffer.byteLength(append) + 65536)
        expect(call?.[2]?.fullParses).toBe(0)
      }
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'appendedneedle'"
            )
            .get()
        )
      ).toEqual({ n: 6 })
    } finally {
      reads.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)

it('retries a refused first observation after settlement without another filesystem event', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-stat-retry')
  const clock = new FakeSessionSearchClock(),
    path = join(harness.claudeProjectDir, 'recovered.jsonl')
  const actual = filesystem.wslGatedStat
  let refused = false
  const probe = vi.spyOn(filesystem, 'wslGatedStat').mockImplementation((observed, ...rest) => {
    if (observed === path && !refused) {
      refused = true
      return Promise.reject(
        Object.assign(new Error('fixture temporary stat refusal'), { code: 'EIO' })
      )
    }
    return actual(observed, ...rest)
  })
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock
  })
  try {
    await writeClaudeTranscript(path, ['recoveredneedle'], 'recovered')
    await subject.start()
    expect(refused).toBe(true)
    clock.advance(20000)
    await subject.settled()
    expect(
      harness.read((db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'recoveredneedle'"
          )
          .get()
      )
    ).toEqual({ n: 2 })
  } finally {
    probe.mockRestore()
    await subject.close()
    await harness.cleanup()
  }
})

it('advances the discovery suffix during continuous updates and repeated overflow', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-crawl-fairness')
  const clock = new FakeSessionSearchClock(),
    root = harness.roots.claudeProjectsDir!
  const active = join(harness.claudeProjectDir, 'active.jsonl')
  const listings = vi.spyOn(filesystem, 'wslGatedReaddir')
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock,
    discoveryDeadlineMs: 0
  })
  try {
    await writeClaudeTranscript(active, ['activebody'], 'active')
    for (let index = 0; index < 16; index++) {
      await writeClaudeTranscript(
        join(root, `bucket${index}`, 'history.jsonl'),
        ['frontierneedle'],
        `history${index}`
      )
    }
    await subject.start()
    listings.mockClear()
    for (let cycle = 0; cycle < 64; cycle++) {
      await appendFile(
        active,
        `${claudeLines(['activeappend'], 'active', cycle * 2 + 10).join('\n')}\n`
      )
      notifySessionSearchFileChange(active)
      notifySessionSearchOverflow(root)
      clock.advance(20000)
      await subject.settled()
    }
    expect(
      harness.read((db) =>
        db
          .prepare(
            "SELECT count(DISTINCT session_row_id) AS n FROM messages JOIN messages_fts ON messages.id=messages_fts.rowid WHERE messages_fts MATCH 'frontierneedle'"
          )
          .get()
      )
    ).toEqual({ n: 16 })
    // An epoch covers sixteen child directories; sixty-four overflow signals cannot restart its root prefix.
    expect(listings.mock.calls.filter(([path]) => path === root).length).toBeLessThanOrEqual(4)
  } finally {
    listings.mockRestore()
    await subject.close()
    await harness.cleanup()
  }
})

it.each([40, 400])(
  'polls %s retained files without rereading unchanged transcripts and retires a deletion',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-polling-delta')
    const clock = new FakeSessionSearchClock()
    const path = join(harness.claudeProjectDir, 'changed.jsonl')
    const deleted = join(harness.claudeProjectDir, 'deleted.jsonl')
    const polling = vi.spyOn(policy, 'sessionSearchRequiresPolling').mockResolvedValue(true)
    const reads = vi.spyOn(parser, 'parseAgentSessionFileCached')
    const subject = new SessionSearchIndexer({
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock
    })
    try {
      await writeClaudeTranscript(path, ['originalbody'], 'changed')
      await writeClaudeTranscript(deleted, ['deletedneedle'], 'deleted')
      for (let index = 0; index < population; index++) {
        await writeClaudeTranscript(
          join(harness.claudeProjectDir, `${index}.jsonl`),
          ['archivebody'],
          `archive${index}`
        )
      }
      await subject.start()
      reads.mockClear()
      clock.advance(20000)
      await subject.settled()
      // Polling must observe membership, but unchanged observations create no transcript read work.
      expect(reads).not.toHaveBeenCalled()
      await appendFile(path, `${claudeLines(['pollchangedneedle'], 'changed', 10).join('\n')}\n`)
      await rm(deleted)
      clock.advance(20000)
      await subject.settled()
      expect(reads).toHaveBeenCalledTimes(1)
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'pollchangedneedle'"
            )
            .get()
        )
      ).toEqual({ n: 2 })
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'deletedneedle'"
            )
            .get()
        )
      ).toEqual({ n: 0 })
    } finally {
      reads.mockRestore()
      polling.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)

it('observes remote message-only edits through polling without a native notification', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-polling-content')
  const clock = new FakeSessionSearchClock()
  const storage = harness.roots.opencodeStorageDir!
  const primary = join(storage, 'session', 'project', 'ses_remote.json')
  const messages = join(storage, 'message', 'ses_remote')
  const polling = vi.spyOn(policy, 'sessionSearchRequiresPolling').mockResolvedValue(true)
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock
  })
  try {
    await mkdir(join(storage, 'session', 'project'), { recursive: true })
    await mkdir(messages, { recursive: true })
    await writeFile(primary, JSON.stringify({ id: 'ses_remote', directory: '/repo/remote' }))
    await writeFile(
      join(messages, 'msg_1.json'),
      JSON.stringify({
        role: 'user',
        content: [{ type: 'text', text: 'originalremote' }],
        time: { created: 1777634000000 }
      })
    )
    await subject.start()
    await writeFile(
      join(messages, 'msg_2.json'),
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: 'remoteinputneedle' }],
        time: { created: 1777634001000 }
      })
    )
    clock.advance(20000)
    await subject.settled()
    expect(
      harness.read((db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'remoteinputneedle'"
          )
          .get()
      )
    ).toEqual({ n: 1 })
    expect(
      harness.read((db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'originalremote'"
          )
          .get()
      )
    ).toEqual({ n: 1 })
  } finally {
    polling.mockRestore()
    await subject.close()
    await harness.cleanup()
  }
})
