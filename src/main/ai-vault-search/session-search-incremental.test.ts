import './session-search-worker.test-fixture'
import { notifySessionSearchFileChange } from './session-search-watcher.test-fixture'
import { appendFile, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as filesystem from '../native-chat/wsl-transcript-fs-access'
import {
  codexFixture,
  CODEX_FIXTURE_SESSION_ID
} from '../ai-vault/scanners/codex/session-scanner-codex-fixtures'
import { subagentTranscriptsDirFor } from '../ai-vault/scanners/claude/session-scanner-subagent-transcripts'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  claudeLines
} from './session-search-indexer-test-fixture'

it.each([40, 400])(
  'bounds idle and one-file work independently of %s archived transcripts',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-incremental')
    const clock = new FakeSessionSearchClock()
    const path = join(harness.claudeProjectDir, 'old.jsonl')
    const stat = vi.spyOn(filesystem, 'wslGatedStat')
    const readdir = vi.spyOn(filesystem, 'wslGatedReaddir')
    const root = harness.roots.claudeProjectsDir!
    const subject = new SessionSearchIndexer({
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock
    })
    try {
      await writeClaudeTranscript(path, ['originalneedle'], 'old')
      for (let index = 0; index < population; index++) {
        await writeClaudeTranscript(
          join(harness.claudeProjectDir, `${index}.jsonl`),
          ['archivedneedle'],
          `${index}`
        )
      }
      await subject.start()
      stat.mockClear()
      readdir.mockClear()
      for (let cycle = 0; cycle < 15; cycle++) {
        clock.advance(20_000)
        await subject.settled()
      }
      // Each cycle needs one root identity probe and at most 12 recent observations, never an archive walk.
      expect(
        stat.mock.calls.filter(([path]) => path === root || path.startsWith(`${root}/`)).length
      ).toBeLessThanOrEqual(15 * 13)
      expect(
        readdir.mock.calls.filter(([path]) => path === root || path.startsWith(`${root}/`))
      ).toHaveLength(0)
      stat.mockClear()
      readdir.mockClear()
      await appendFile(path, `${claudeLines(['changedneedle'], 'old', 10).join('\n')}\n`)
      notifySessionSearchFileChange(path)
      clock.advance(20_000)
      await subject.settled()
      // One changed path adds one discovery observation and the reader's bounded identity checks.
      expect(
        stat.mock.calls.filter(([path]) => path === root || path.startsWith(`${root}/`)).length
      ).toBeLessThanOrEqual(16)
      expect(
        readdir.mock.calls.filter(
          ([observed]) =>
            observed !== subagentTranscriptsDirFor(path) &&
            (observed === root || observed.startsWith(`${root}/`))
        )
      ).toHaveLength(0)
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'changedneedle'"
            )
            .get()
        )
      ).toEqual({ n: 2 })
    } finally {
      await subject.close()
      stat.mockRestore()
      readdir.mockRestore()
      await harness.cleanup()
    }
  }
)

it('resumes partially observed directories and retains a create behind the consumed prefix', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-discovery-resume')
  const root = harness.claudeProjectDir
  await mkdir(root, { recursive: true })
  for (let index = 0; index < 40; index++) {
    await writeFile(join(root, `${index}.jsonl`), '{}\n')
  }
  const inventory = harness.inventory(root)
  const observations: string[] = []
  const stat = vi.spyOn(filesystem, 'wslGatedStat')
  try {
    const args = {
      rootDir: root,
      agent: 'claude' as const,
      limit: Infinity,
      extensions: ['.jsonl'],
      issues: []
    }
    const first = await inventory.drain(args, () => true, 12)
    observations.push(...first.changes.map((change) => change.file.path))
    expect(inventory.pending).toBe(true)
    const created = join(root, 'created.jsonl')
    await writeFile(created, '{}\n')
    await inventory.invalidate(created)
    while (inventory.pending) {
      const next = await inventory.drain(args, () => true, 12)
      observations.push(...next.changes.map((change) => change.file.path))
    }
    expect(observations).toHaveLength(41)
    expect(new Set(observations).size).toBe(41)
    expect(observations).toContain(created)
    // The completed prefix is not rediscovered when the next slice consumes its retained cursor.
    expect(stat.mock.calls.filter(([path]) => path.startsWith(`${root}/`))).toHaveLength(41)
  } finally {
    stat.mockRestore()
    await harness.cleanup()
  }
})

it('indexes a delivered equal-stat rewrite outside the recent window', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-equal-stat')
  const clock = new FakeSessionSearchClock()
  const path = join(harness.claudeProjectDir, 'old.jsonl')
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    recentPerAgent: 1,
    clock
  })
  try {
    await writeClaudeTranscript(path, ['initialneedle'], 'old')
    await writeClaudeTranscript(join(harness.claudeProjectDir, 'new.jsonl'), ['otherneedle'], 'new')
    const old = await stat(path)
    await subject.start()
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replaceAll('initialneedle', 'changedneedle')
    )
    await utimes(path, old.atime, old.mtime)
    notifySessionSearchFileChange(path)
    clock.advance(20_000)
    await subject.settled()
    expect(
      harness.read((db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'changedneedle'"
          )
          .get()
      )
    ).toEqual({ n: 2 })
    expect(
      harness.read((db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'initialneedle'"
          )
          .get()
      )
    ).toEqual({ n: 0 })
  } finally {
    await subject.close()
    await harness.cleanup()
  }
})

it('publishes title-only metadata changes and retries a refused publication', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-title-publication')
  const clock = new FakeSessionSearchClock()
  const fixture = codexFixture()
  const root = harness.roots.codexSessionsDir!
  const path = join(root, fixture.fileName)
  const index = join(dirname(root), 'session_index.jsonl')
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock
  })
  const title = () =>
    harness.read((db) => db.prepare("SELECT title FROM sessions WHERE agent='codex'").get())
  try {
    await mkdir(root, { recursive: true })
    await writeFile(path, `${fixture.seedLines.join('\n')}\n`)
    await writeFile(
      index,
      `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Original title' })}\n`
    )
    await subject.start()
    expect(title()).toEqual({ title: 'Original title' })
    harness.write((db) =>
      db.exec(
        "CREATE TRIGGER refuse_title BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'refused fixture metadata'); END"
      )
    )
    await writeFile(
      index,
      `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Changed title' })}\n`
    )
    notifySessionSearchFileChange(index)
    clock.advance(20_000)
    await subject.settled()
    expect(title()).toEqual({ title: 'Original title' })
    harness.write((db) => db.exec('DROP TRIGGER refuse_title'))
    clock.advance(20_000)
    await subject.settled()
    expect(title()).toEqual({ title: 'Changed title' })
  } finally {
    await subject.close()
    await harness.cleanup()
  }
})
