import './session-search-watcher.test-fixture'
import './session-search-worker.test-fixture'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { SessionSearchIndexer } from './session-search-indexer'
import { SessionSearchWorkerClient } from './session-search-worker-client'
import {
  notifySessionSearchFileChange,
  notifySessionSearchOverflow
} from './session-search-watcher.test-fixture'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript
} from './session-search-indexer-test-fixture'

vi.mock('./session-search-filesystem', () => ({ sessionSearchRequiresPolling: async () => false }))

it.each([
  'event-before',
  'event-after',
  'prepare-before',
  'prepare-after',
  'directory-schedule'
] as const)(
  'retains a delivered new conversation across %s rejection without a second notice',
  async (failure) => {
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
          command.op === 'catalog' &&
          ((failure.startsWith('event-') &&
            command.command.kind === 'input-invalidate' &&
            command.command.path === second) ||
            (failure.startsWith('prepare-') &&
              command.command.kind === 'observe-prepare' &&
              command.command.inputs.some((input) => input.path === second)) ||
            (failure === 'directory-schedule' &&
              command.command.kind === 'directory-schedule' &&
              command.command.path === directory))
        if (armed && !rejected && target) {
          rejected = true
          if (failure.endsWith('after')) {
            await request.call(this, command)
          }
          throw new Error('fixture catalog handoff rejected')
        }
        return request.call(this, command)
      })
    const hits = () =>
      harness.read((db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'handoffneedle'"
          )
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
      expect(errors).toHaveLength(1)
      // Only resume the failed boundary; no new notification, full refresh or maintenance tick.
      await subject.reconcile()
      expect(hits()).toEqual({ n: 4 })
      expect(subject.status().phase).toBe('current')
    } finally {
      gate.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)

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
          throw new Error('fixture native recovery rejected')
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
