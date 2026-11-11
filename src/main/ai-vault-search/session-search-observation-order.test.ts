import './session-search-worker.test-fixture'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as filesystem from '../native-chat/wsl-transcript-fs-access'
import { SessionSearchWorkerClient } from './session-search-worker-client'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  notifySessionSearchFileChange,
  notifySessionSearchOverflow
} from './session-search-watcher.test-fixture'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript
} from './session-search-indexer-test-fixture'

it.each(['file', 'subtree'] as const)(
  'keeps a delivered %s change newer than an unfinished folder observation',
  async (variant) => {
    const harness = await openSessionSearchIndexerHarness('ss-newer-folder-input')
    const clock = new FakeSessionSearchClock()
    const directory =
      variant === 'subtree' ? harness.roots.claudeProjectsDir! : harness.claudeProjectDir
    const child = join(directory, 'zz-recreated')
    const path = join(variant === 'subtree' ? child : directory, 'zz-new.jsonl')
    const subject = new SessionSearchIndexer({
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock,
      discoveryDeadlineMs: 1000
    })
    let paused = false,
      refusing = false,
      attempts = 0,
      transferred = false
    const request = SessionSearchWorkerClient.prototype.request
    const stat = filesystem.wslGatedStat
    const gate = vi
      .spyOn(SessionSearchWorkerClient.prototype, 'request')
      .mockImplementation(async function (this: SessionSearchWorkerClient, command) {
        const result = await request.call(this, command)
        if (
          variant === 'subtree' &&
          !transferred &&
          attempts === 1 &&
          command.op === 'catalog' &&
          command.command.kind === 'observe-prepare' &&
          command.command.inputs.some((input) => input.path === path) &&
          result.catalog?.prepared?.some((input) => input.path === path && input.attempt)
        ) {
          transferred = true
          // Deliver a real subtree input and run its wake while this earlier observation owns the path.
          await request.call(this, {
            op: 'catalog',
            command: {
              kind: 'input-invalidate',
              scope: command.command.scope,
              path: child,
              force: true,
              subtree: true
            }
          })
          await request.call(this, {
            op: 'catalog',
            command: {
              kind: 'retry-admit',
              scope: command.command.scope,
              root: harness.roots.claudeProjectsDir!,
              generation: command.command.generation
            }
          })
        }
        if (
          !paused &&
          command.op === 'catalog' &&
          command.command.kind === 'directory-step' &&
          command.command.path === directory &&
          command.command.phase === (variant === 'subtree' ? 'children' : 'files') &&
          result.catalog?.after
        ) {
          paused = true
          clock.advance(1000)
        }
        return result
      })
    const probe = vi.spyOn(filesystem, 'wslGatedStat').mockImplementation((observed, ...rest) => {
      if (refusing && observed === path) {
        attempts++
        return Promise.reject(
          Object.assign(new Error('fixture newer input refusal'), { code: 'EIO' })
        )
      }
      return stat(observed, ...rest)
    })
    const hits = (query: string) =>
      harness.read((db) =>
        db.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get(query)
      )
    try {
      // More than one membership page makes the old observation cross a pass boundary.
      for (let index = 0; index < 300; index++) {
        await writeClaudeTranscript(
          variant === 'subtree'
            ? join(directory, String(index).padStart(3, '0'), 'existing.jsonl')
            : join(directory, `${String(index).padStart(3, '0')}.jsonl`),
          ['existingbody'],
          `existing-${index}`
        )
      }
      if (variant === 'subtree') {
        await writeClaudeTranscript(join(child, 'old.jsonl'), ['retiredchildneedle'], 'old-child')
      }
      // The first build is complete before arranging the recovery overlap.
      paused = true
      await subject.start()
      expect(hits('existingbody')).toEqual({ n: 600 })
      if (variant === 'subtree') {
        await rm(child, { recursive: true })
      }
      paused = false
      notifySessionSearchOverflow(harness.roots.claudeProjectsDir!)
      await subject.reconcile()
      expect(paused).toBe(true)
      refusing = variant === 'subtree'
      await writeClaudeTranscript(path, ['newerinputneedle'], 'newer-input')
      // Only the keyed file notice is delivered; no parent notice or second full refresh repairs it.
      for (let cycle = 0; cycle < 6; cycle++) {
        await subject.reconcile()
      }
      if (variant === 'subtree') {
        expect(transferred).toBe(true)
        // One prior refusal, one superseded read, then three owned attempts after the legitimate wake.
        expect(attempts).toBe(5)
        expect(hits('newerinputneedle')).toEqual({ n: 0 })
        expect(subject.status().phase).not.toBe('indexing')
        refusing = false
        notifySessionSearchFileChange(path)
      }
      // Two membership pages, staged-input cleanup and authority cleanup each have an empty acknowledgement.
      for (let cycle = 0; cycle < 6; cycle++) {
        await subject.reconcile()
      }
      expect(hits('newerinputneedle')).toEqual({ n: 2 })
      if (variant === 'subtree') {
        expect(hits('retiredchildneedle')).toEqual({ n: 0 })
      }
      expect(subject.status().phase).not.toBe('indexing')
    } finally {
      gate.mockRestore()
      probe.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)

it('discovers searchable conversations when a directory page exceeds the transport size', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-long-directory-page')
  const root = join(harness.root, 'a'.repeat(120), 'b'.repeat(120), 'c'.repeat(120), 'projects')
  const project = join(root, 'project')
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: { ...harness.roots, claudeProjectsDir: root },
    historyDays: null,
    clock: new FakeSessionSearchClock()
  })
  const requests = vi.spyOn(SessionSearchWorkerClient.prototype, 'request')
  try {
    for (let index = 0; index < 256; index++) {
      await writeClaudeTranscript(
        join(project, `${String(index).padStart(3, '0')}-${'d'.repeat(110)}.jsonl`),
        ['longdirectoryneedle'],
        `long-directory-${index}`
      )
    }
    await subject.start()
    expect(
      harness.read((db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'longdirectoryneedle'"
          )
          .get()
      )
    ).toEqual({ n: 512 })
    expect(subject.status().phase).toBe('current')
    for (const [command] of requests.mock.calls) {
      if (command.op === 'candidates' && command.command.kind === 'unowned-page') {
        expect(command.command.rows.length).toBeLessThanOrEqual(256)
        expect(JSON.stringify(command).length * 2 + 1024).toBeLessThanOrEqual(256 * 1024)
      }
    }
  } finally {
    requests.mockRestore()
    await subject.close()
    await harness.cleanup()
  }
})
