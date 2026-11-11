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
import { SessionSearchWorkerClient } from './session-search-worker-client'
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
    const traffic = vi.spyOn(SessionSearchWorkerClient.prototype, 'request')
    const catalogTraffic = () =>
      traffic.mock.calls.filter(
        ([command]) => command.op === 'catalog' && command.command.scope.includes(root)
      )
    const catalogRows = () =>
      catalogTraffic().reduce((total, [command]) => {
        if (command.op !== 'catalog') {
          return total
        }
        const input = command.command
        return (
          total +
          ('rows' in input
            ? input.rows.length
            : 'inputs' in input
              ? input.inputs.length
              : 'outcomes' in input
                ? input.outcomes.length
                : 'keys' in input
                  ? input.keys.length
                  : 0)
        )
      }, 0)
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
      traffic.mockClear()
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
      // Only bounded empty refusal/ready probes are required for an unchanged known root.
      expect(catalogTraffic().length).toBeLessThanOrEqual(15 * 8)
      expect(catalogRows()).toBe(0)
      stat.mockClear()
      readdir.mockClear()
      traffic.mockClear()
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
      // One changed input permits a bounded prepare/apply pair and its keyed admission, not archive records.
      expect(catalogRows()).toBeLessThanOrEqual(8)
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
      traffic.mockRestore()
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

it('preserves delivered equal-stat rewrites while Claude and Codex roots drain together', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-equal-stat')
  const clock = new FakeSessionSearchClock()
  const path = join(harness.claudeProjectDir, 'old.jsonl')
  const fixture = codexFixture()
  const codexPath = join(harness.roots.codexSessionsDir!, fixture.fileName)
  const indexPath = join(dirname(harness.roots.codexSessionsDir!), 'session_index.jsonl')
  let restore: () => void = () => undefined
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
    await mkdir(dirname(codexPath), { recursive: true })
    await writeFile(codexPath, `${fixture.seedLines.join('\n')}\n`)
    await writeFile(
      indexPath,
      `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Before title' })}\n`
    )
    const preservedTime = new Date('2024-01-01T00:00:00Z')
    await utimes(path, preservedTime, preservedTime)
    await utimes(codexPath, preservedTime, preservedTime)
    const codexOld = await stat(codexPath)
    const old = await stat(path)
    await subject.start()
    const acceptingA = Promise.withResolvers<void>()
    const observedB = Promise.withResolvers<void>()
    let blockedClaude = false,
      blockedCodex = false,
      observedClaude = false
    const request = SessionSearchWorkerClient.prototype.request
    const intercept = vi
      .spyOn(SessionSearchWorkerClient.prototype, 'request')
      .mockImplementation(async function (this: SessionSearchWorkerClient, command) {
        const result = await request.call(this, command)
        if (
          command.op === 'catalog' &&
          command.command.scope.includes(harness.roots.claudeProjectsDir!) &&
          command.command.kind === 'page' &&
          command.command.scope.endsWith(':refusals')
        ) {
          blockedClaude = true
          await acceptingA.promise
        }
        if (
          command.op === 'candidates' &&
          command.command.kind === 'contested' &&
          command.command.rows.some((row) => row.path === codexPath)
        ) {
          blockedCodex = true
          acceptingA.resolve()
          await observedB.promise
        }
        if (
          command.op === 'catalog' &&
          command.command.kind === 'observe-apply' &&
          command.command.outcomes.some((row) => row.path === path)
        ) {
          observedClaude = true
          observedB.resolve()
        }
        return result
      })
    restore = () => intercept.mockRestore()
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replaceAll('initialneedle', 'changedneedle')
    )
    await utimes(path, old.atime, old.mtime)
    await writeFile(
      codexPath,
      (await readFile(codexPath, 'utf8')).replace('codex seed question', 'codex newx question')
    )
    await utimes(codexPath, codexOld.atime, codexOld.mtime)
    await writeFile(
      indexPath,
      `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'After title' })}\n`
    )
    notifySessionSearchFileChange(indexPath)
    notifySessionSearchFileChange(codexPath)
    notifySessionSearchFileChange(path)
    clock.advance(20_000)
    await subject.settled()
    expect([blockedClaude, blockedCodex, observedClaude]).toEqual([true, true, true])
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
    expect(
      harness.read((db) =>
        db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'newx'").get()
      )
    ).toEqual({ n: 1 })
    expect(
      harness.read((db) => db.prepare("SELECT title FROM sessions WHERE agent='codex'").get())
    ).toEqual({ title: 'After title' })
  } finally {
    restore()
    await subject.close()
    await harness.cleanup()
  }
})

it('retains title-only work through admission refusal and wakes held-out publication on a newer title', async () => {
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
  const actualStat = filesystem.wslGatedStat
  let refuseAdmission = false
  const probe = vi.spyOn(filesystem, 'wslGatedStat').mockImplementation((observed, ...rest) => {
    if (refuseAdmission && observed === path) {
      refuseAdmission = false
      return Promise.reject(
        Object.assign(new Error('fixture refused primary admission'), { code: 'EACCES' })
      )
    }
    return actualStat(observed, ...rest)
  })
  const streams = vi.spyOn(filesystem, 'openTranscriptReadStream')
  const slices = vi.spyOn(filesystem, 'readTranscriptSlice')
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
    streams.mockClear()
    slices.mockClear()
    refuseAdmission = true
    await writeFile(
      index,
      `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Admission recovered title' })}\n`
    )
    notifySessionSearchFileChange(index)
    clock.advance(20_000)
    await subject.settled()
    expect(title()).toEqual({ title: 'Original title' })
    clock.advance(20_000)
    await subject.settled()
    expect(title()).toEqual({ title: 'Admission recovered title' })

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
    expect(title()).toEqual({ title: 'Admission recovered title' })
    harness.write((db) => db.exec('DROP TRIGGER refuse_title'))
    clock.advance(20_000)
    await subject.settled()
    expect(title()).toEqual({ title: 'Changed title' })
    harness.write((db) =>
      db.exec(
        "CREATE TRIGGER refuse_title BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'refused fixture metadata'); END"
      )
    )
    await appendFile(
      index,
      `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Held title' })}\n`
    )
    notifySessionSearchFileChange(index)
    for (let cycle = 0; cycle < 4; cycle++) {
      clock.advance(20_000)
      await subject.settled()
    }
    expect(subject.status().phase).toBe('degraded')
    expect(subject.status().filesDue).toBe(0)
    expect(title()).toEqual({ title: 'Changed title' })
    harness.write((db) => db.exec('DROP TRIGGER refuse_title'))
    await appendFile(
      index,
      `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Delivered title' })}\n`
    )
    notifySessionSearchFileChange(index)
    clock.advance(20_000)
    await subject.settled()
    expect(title()).toEqual({ title: 'Delivered title' })
    expect(subject.status().phase).toBe('current')
    const request = SessionSearchWorkerClient.prototype.request
    const admitted = new Map<number, Promise<unknown>>()
    let foreignCommit = false
    const gate = vi
      .spyOn(SessionSearchWorkerClient.prototype, 'request')
      .mockImplementation(async function (this: SessionSearchWorkerClient, command) {
        if (command.op === 'begin') {
          const accepted = request.call(this, command).then((result) => {
            expect(result.accepted).toBe(true)
            return result
          })
          admitted.set(command.handle, accepted)
          return accepted
        }
        if (!foreignCommit && command.op === 'finish') {
          const begin = admitted.get(command.handle)
          expect(begin).toBeDefined()
          await begin
          foreignCommit = true
          harness.write((db) =>
            db
              .prepare(
                "INSERT OR REPLACE INTO meta(key,value) VALUES ('fixture_foreign_commit','1')"
              )
              .run()
          )
        }
        return request.call(this, command)
      })
    try {
      await appendFile(
        index,
        `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Cancelled then retried title' })}\n`
      )
      notifySessionSearchFileChange(index)
      clock.advance(20_000)
      await subject.settled()
      expect(foreignCommit).toBe(true)
      expect(title()).toEqual({ title: 'Delivered title' })
      clock.advance(20_000)
      await subject.settled()
      expect(title()).toEqual({ title: 'Cancelled then retried title' })
      expect(subject.status().phase).toBe('current')
    } finally {
      gate.mockRestore()
    }

    expect(streams.mock.calls.filter(([readPath]) => readPath === path)).toHaveLength(0)
    expect(slices.mock.calls.filter(([readPath]) => readPath === path)).toHaveLength(0)
  } finally {
    probe.mockRestore()
    streams.mockRestore()
    slices.mockRestore()
    await subject.close()
    await harness.cleanup()
  }
})

it.each(['commit', 'open', 'observation'] as const)(
  'retains rewritten content through a failed %s and parks until a real content wake',
  async (failure) => {
    const harness = await openSessionSearchIndexerHarness('ss-content-retry')
    const clock = new FakeSessionSearchClock()
    const fixture = codexFixture()
    const root = harness.roots.codexSessionsDir!
    const path = join(root, fixture.fileName)
    const index = join(dirname(root), 'session_index.jsonl')
    let subject = new SessionSearchIndexer({
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock
    })
    const current = () =>
      harness.read((db) => ({
        text: db
          .prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'newx'")
          .get(),
        title: db.prepare("SELECT title FROM sessions WHERE agent='codex'").get()
      }))
    const stream = filesystem.openTranscriptReadStream
    let refuseOpen = false
    let refuseObservation = false
    let observations = 0
    const actualStat = filesystem.wslGatedStat
    const observation = vi
      .spyOn(filesystem, 'wslGatedStat')
      .mockImplementation((observed, ...args) => {
        if (observed === path) {
          observations++
        }
        if (refuseObservation && observed === path) {
          return Promise.reject(
            Object.assign(new Error('fixture refused observation'), { code: 'EIO' })
          )
        }
        return actualStat(observed, ...args)
      })
    const primary = vi
      .spyOn(filesystem, 'openTranscriptReadStream')
      .mockImplementation((readPath, ...args) => {
        if (refuseOpen && readPath === path) {
          throw Object.assign(new Error('fixture refused content'), { code: 'EACCES' })
        }
        return stream(readPath, ...args)
      })
    const refuse = () => {
      if (failure === 'open') {
        refuseOpen = true
      } else if (failure === 'observation') {
        refuseObservation = true
      } else {
        harness.write((db) =>
          db.exec(
            "CREATE TRIGGER refuse_content BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'fixture refused content'); END"
          )
        )
      }
    }
    const allow = () => {
      refuseOpen = false
      refuseObservation = false
      if (failure === 'commit') {
        harness.write((db) => db.exec('DROP TRIGGER refuse_content'))
      }
    }
    const rewrite = async (from: string, to: string, title: string) => {
      const previous = await stat(path)
      await writeFile(path, (await readFile(path, 'utf8')).replace(from, to))
      await utimes(path, previous.atime, previous.mtime)
      await writeFile(
        index,
        `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: title })}\n`
      )
      notifySessionSearchFileChange(path)
      notifySessionSearchFileChange(index)
    }
    const cycle = async () => {
      clock.advance(20_000)
      await subject.settled()
    }
    try {
      await mkdir(root, { recursive: true })
      await writeFile(path, `${fixture.seedLines.join('\n')}\n`)
      await writeFile(
        index,
        `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Original title' })}\n`
      )
      await subject.start()
      refuse()
      await rewrite('codex seed question', 'codex newx question', 'Rewritten title')
      await cycle()
      expect(current()).toEqual({ text: { n: 0 }, title: { title: 'Original title' } })
      allow()
      await cycle()
      expect(current()).toEqual({ text: { n: 1 }, title: { title: 'Rewritten title' } })
      expect(subject.status().phase).toBe('current')
      observations = 0
      refuse()
      await rewrite('codex newx question', 'codex next question', 'Held title')
      for (let attempt = 0; attempt < 3; attempt++) {
        await cycle()
      }
      if (failure !== 'observation') {
        expect(
          harness.read((db) =>
            db.prepare('SELECT state,fail_count FROM files WHERE path=?').get(path)
          )
        ).toEqual({ state: 'failed', fail_count: 3 })
      }
      if (failure === 'observation') {
        expect(observations).toBe(3)
        expect(subject.status().phase).not.toBe('indexing')
      } else {
        expect(subject.status().phase).toBe('degraded')
      }
      expect(subject.status().filesDue).toBe(0)
      allow()
      await cycle()
      if (failure === 'observation') {
        expect(observations).toBe(3)
      }
      expect(current()).toEqual({ text: { n: 1 }, title: { title: 'Rewritten title' } })
      if (failure === 'open') {
        await subject.close()
        subject = new SessionSearchIndexer({
          databasePath: harness.databasePath,
          roots: harness.roots,
          historyDays: null,
          clock
        })
        await subject.start()
        expect(
          harness.read((db) =>
            db.prepare('SELECT state,fail_count FROM files WHERE path=?').get(path)
          )
        ).toEqual({ state: 'failed', fail_count: 3 })
        expect(current()).toEqual({ text: { n: 1 }, title: { title: 'Rewritten title' } })
        await subject.reconcile({ full: true })
        await cycle()
      } else if (failure === 'commit') {
        // The existing fifteen-cycle maintenance is a recovery input, without another source notice.
        for (let cycleIndex = 0; cycleIndex < 16; cycleIndex++) {
          await cycle()
        }
      } else {
        notifySessionSearchFileChange(path)
        await cycle()
      }
      expect(current()).toEqual({ text: { n: 0 }, title: { title: 'Held title' } })
      expect(
        harness.read((db) =>
          db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'next'").get()
        )
      ).toEqual({ n: 1 })
      expect(subject.status().phase).toBe('current')
    } finally {
      primary.mockRestore()
      observation.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)
