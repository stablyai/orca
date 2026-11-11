import {
  notifySessionSearchFileChange,
  notifySessionSearchOverflow
} from './session-search-watcher.test-fixture'
import './worker/session-search-worker.test-fixture'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import * as filesystem from '../native-chat/wsl-transcript-fs-access'
import { expect, it, vi } from 'vitest'
import { SessionSearchIndexer } from './indexing/session-search-indexer'
import {
  SessionSearchOperationError,
  SessionSearchWorkerClient
} from './worker/session-search-worker-client'
import {
  claudeLines,
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript
} from './indexing/session-search-indexer-test-fixture'

vi.mock('./session-search-filesystem', () => ({ sessionSearchRequiresPolling: async () => false }))

it.each([
  'event-before',
  'event-after',
  'prepare-before',
  'prepare-after',
  'apply-before',
  'apply-after',
  'apply-newer',
  'transfer-before',
  'transfer-after',
  'directory-schedule'
] as const)('retains a delivered new conversation across %s rejection', async (failure) => {
  const harness = await openSessionSearchIndexerHarness('ss-input-handoff')
  const root = harness.roots.claudeProjectsDir!
  const directory = join(root, 'new-project')
  const first = join(harness.claudeProjectDir, 'first.jsonl')
  const second = join(
    failure === 'directory-schedule' ? directory : harness.claudeProjectDir,
    'second.jsonl'
  )
  const clock = new FakeSessionSearchClock()
  const errors: unknown[] = []
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock,
    onError: (error) => errors.push(error)
  })
  const request = SessionSearchWorkerClient.prototype.request
  let armed = false,
    rejected = false
  const gate = vi
    .spyOn(SessionSearchWorkerClient.prototype, 'request')
    .mockImplementation(async function (this: SessionSearchWorkerClient, command) {
      const target =
        (command.op === 'catalog' &&
          ((failure.startsWith('event-') &&
            command.command.kind === 'input-invalidate' &&
            command.command.path === second) ||
            (failure.startsWith('prepare-') &&
              command.command.kind === 'observe-prepare' &&
              command.command.inputs.some((input) => input.path === second)) ||
            (failure.startsWith('apply-') &&
              command.command.kind === 'observe-apply' &&
              command.command.outcomes.some((input) => input.path === second)) ||
            (failure === 'directory-schedule' &&
              command.command.kind === 'directory-schedule' &&
              command.command.path === directory))) ||
        (command.op === 'candidates' &&
          failure.startsWith('transfer-') &&
          command.command.kind === 'batch' &&
          !!command.command.admission &&
          command.command.rows.some((row) => row.candidate.file.path === second))
      if (armed && !rejected && target) {
        rejected = true
        if (failure.endsWith('after')) {
          await request.call(this, command)
        }
        throw new SessionSearchOperationError('fixture catalog handoff rejected')
      }
      return request.call(this, command)
    })
  const hits = () =>
    harness.read((db) =>
      db
        .prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'handoffneedle'")
        .get()
    )
  try {
    await mkdir(harness.claudeProjectDir, { recursive: true })
    await subject.start()
    await writeClaudeTranscript(first, ['handoffneedle'], 'handoff-first')
    await writeClaudeTranscript(second, ['handoffneedle'], 'handoff-second')
    if (failure === 'directory-schedule') {
      notifySessionSearchFileChange(directory)
    }
    armed = true
    await subject.reconcile()
    expect(rejected).toBe(true)
    expect(errors.some((error) => error instanceof SessionSearchOperationError)).toBe(true)
    if (failure === 'apply-newer') {
      await writeClaudeTranscript(second, ['supersedingneedle'], 'handoff-second')
      notifySessionSearchFileChange(second)
    }
    // Resume retained work without a full refresh or maintenance tick.
    await subject.reconcile()
    expect(hits()).toEqual({ n: failure === 'apply-newer' ? 2 : 4 })
    if (failure === 'apply-newer') {
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'supersedingneedle'"
            )
            .get()
        )
      ).toEqual({ n: 2 })
    }
    expect(subject.status().phase).toBe('current')
  } finally {
    gate.mockRestore()
    await subject.close()
    await harness.cleanup()
  }
})

it.each(['before', 'after'] as const)(
  'retains native recovery across an accepted-result %s rejection',
  async (completion) => {
    const harness = await openSessionSearchIndexerHarness('ss-native-recovery')
    const path = join(harness.claudeProjectDir, 'session.jsonl')
    const clock = new FakeSessionSearchClock()
    const subject = new SessionSearchIndexer({
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock
    })
    const request = SessionSearchWorkerClient.prototype.request
    let armed = false,
      rejected = false
    const gate = vi
      .spyOn(SessionSearchWorkerClient.prototype, 'request')
      .mockImplementation(async function (this: SessionSearchWorkerClient, command) {
        if (
          armed &&
          !rejected &&
          command.op === 'catalog' &&
          command.command.kind === 'retry-wake' &&
          command.command.all &&
          command.command.receipt?.consumer.endsWith(':recovery')
        ) {
          rejected = true
          if (completion === 'after') {
            await request.call(this, command)
          }
          throw new SessionSearchOperationError('fixture native recovery rejected')
        }
        return request.call(this, command)
      })
    try {
      await writeClaudeTranscript(path, ['nativeold'], 'native-recovery')
      await subject.start()
      harness.write((db) =>
        db.exec(
          "CREATE TRIGGER refuse_native BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'fixture refused content'); END"
        )
      )
      await writeClaudeTranscript(path, ['nativenew'], 'native-recovery')
      for (let attempt = 0; attempt < 3; attempt++) {
        clock.advance(20_000)
        await subject.settled()
      }
      expect(
        harness.read((db) =>
          db.prepare('SELECT state,fail_count FROM files WHERE path=?').get(path)
        )
      ).toEqual({ state: 'failed', fail_count: 3 })
      harness.write((db) => db.exec('DROP TRIGGER refuse_native'))
      armed = true
      expect(notifySessionSearchOverflow(harness.roots.claudeProjectsDir!)).toBe(1)
      await subject.reconcile()
      expect(rejected).toBe(true)
      await subject.reconcile()
      expect(
        harness.read((db) =>
          db
            .prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'nativenew'")
            .get()
        )
      ).toEqual({ n: 2 })
      expect(subject.status().phase).toBe('current')
    } finally {
      gate.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)

it.each(['acknowledgement', 'accepted-refusal'] as const)(
  'charges a directory refusal only for an actual failed inspection across %s rejection',
  async (failure) => {
    const harness = await openSessionSearchIndexerHarness('ss-probe-refusal-handoff')
    const directory = join(harness.roots.claudeProjectsDir!, 'unreadable')
    const path = join(directory, 'session.jsonl')
    const clock = new FakeSessionSearchClock()
    const subject = new SessionSearchIndexer({
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock,
      onError: () => undefined
    })
    const request = SessionSearchWorkerClient.prototype.request
    const stat = filesystem.wslGatedStat
    let refusing = true,
      rejected = 0,
      attempts = 0
    const probe = vi.spyOn(filesystem, 'wslGatedStat').mockImplementation((input, ...rest) => {
      if (refusing && input === directory) {
        attempts++
        return Promise.reject(
          Object.assign(new Error('fixture directory inspection refused'), { code: 'EIO' })
        )
      }
      return stat(input, ...rest)
    })
    const readdir = filesystem.wslGatedReaddir
    const listing = vi.spyOn(filesystem, 'wslGatedReaddir').mockImplementation((input, ...rest) => {
      if (refusing && input === directory) {
        attempts++
        return Promise.reject(
          Object.assign(new Error('fixture directory inspection refused'), { code: 'EIO' })
        )
      }
      return readdir(input, ...rest)
    })
    const gate = vi
      .spyOn(SessionSearchWorkerClient.prototype, 'request')
      .mockImplementation(async function (this: SessionSearchWorkerClient, command) {
        if (
          rejected < 2 &&
          attempts === 1 &&
          command.op === 'catalog' &&
          'path' in command.command &&
          command.command.path === directory &&
          command.command.kind === (failure === 'acknowledgement' ? 'dirty-ack' : 'retry-fail')
        ) {
          rejected++
          if (failure === 'accepted-refusal') {
            await request.call(this, command)
          }
          throw new SessionSearchOperationError('fixture refusal acknowledgement rejected')
        }
        return request.call(this, command)
      })
    try {
      await mkdir(harness.claudeProjectDir, { recursive: true })
      await subject.start()
      await mkdir(directory)
      await writeFile(
        path,
        `${claudeLines(['proberecoveryneedle'], 'probe-refusal', 0).join('\n')}\n`
      )
      notifySessionSearchFileChange(directory)
      await subject.reconcile()
      expect(rejected).toBe(1)
      // Three actual inspections own the holdout, not the replay of an accepted refusal.
      for (let cycle = 0; cycle < 4; cycle++) {
        clock.advance(20_000)
        await subject.settled()
      }
      expect(attempts).toBe(3)
      expect(subject.status().phase).toBe('current')
      refusing = false
      notifySessionSearchFileChange(directory)
      await subject.reconcile()
      await subject.reconcile()
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'proberecoveryneedle'"
            )
            .get()
        )
      ).toEqual({ n: 2 })
      expect(subject.status().phase).toBe('current')
    } finally {
      gate.mockRestore()
      probe.mockRestore()
      listing.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)
