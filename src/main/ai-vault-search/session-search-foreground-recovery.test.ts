import './session-search-worker.test-fixture'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SessionSearchWorkerClient } from './session-search-worker-client'
import SyncDatabase from '../sqlite/sync-database'
import { SessionSearchWorkerStore } from './session-search-worker-store'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { syntheticCandidate } from './session-search-index-test-fixture'
import { writeClaudeTranscript } from './session-search-indexer-test-fixture'
import { readResumableTranscript } from '../ai-vault/transcripts/session-transcript-reader'
import { createClaudeSessionResumeState } from '../ai-vault/scanners/claude/session-scanner-primary-parsers'

it('publishes a cold foreground read and preserves accepted messages across cold append and covered restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ss-cold-foreground-'))
  const path = join(root, 'index.sqlite')
  const file = join(root, 'conversation.jsonl')
  let store: SessionSearchWorkerStore | undefined
  let unregister: (() => void) | undefined
  const reopen = async () => {
    unregister?.()
    store?.close()
    await store?.retired()
    store = new SessionSearchWorkerStore(path, (error) => {
      throw error
    })
    await store.prepare()
    unregister = registerSessionSearchIndexConsumer(store)
  }
  const read = async (parsed?: () => void) => {
    const info = await stat(file)
    const candidate = syntheticCandidate({
      path: file,
      mtimeMs: info.mtimeMs,
      sizeBytes: info.size,
      dev: info.dev,
      ino: info.ino
    })
    const result = await readResumableTranscript({
      candidate,
      platform: process.platform,
      resume: null,
      stateFactory: (channel) => createClaudeSessionResumeState(candidate.file, channel)
    })
    parsed?.()
    await store!.flush()
    return result.session
  }
  const accepted = () => {
    const db = new SyncDatabase(path, { readonly: true })
    try {
      return {
        session: db.prepare('SELECT id, content_hash_count FROM sessions').get(),
        messages: db.prepare('SELECT count(*) AS n FROM messages').get(),
        hits: db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'coldappendneedle'"
          )
          .get()
      }
    } finally {
      db.close()
    }
  }
  try {
    await writeClaudeTranscript(file, ['coldstartneedle'], 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    await reopen()
    expect(await read()).toMatchObject({ messageCount: 2 })
    expect(accepted()).toEqual({
      session: { id: 1, content_hash_count: 2 },
      messages: { n: 2 },
      hits: { n: 0 }
    })
    await reopen()
    await writeClaudeTranscript(
      file,
      ['coldstartneedle', 'coldappendneedle'],
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    )
    expect(await read()).toMatchObject({ messageCount: 4 })
    expect(accepted()).toEqual({
      session: { id: 1, content_hash_count: 4 },
      messages: { n: 4 },
      hits: { n: 2 }
    })
    await reopen()
    const admission = Promise.withResolvers<void>()
    const parsed = Promise.withResolvers<void>()
    const request = SessionSearchWorkerClient.prototype.request
    const transferred = vi
      .spyOn(SessionSearchWorkerClient.prototype, 'request')
      .mockImplementation(async function (this: SessionSearchWorkerClient, command) {
        if (command.op === 'begin' && command.unprepared) {
          await admission.promise
        }
        return request.call(this, command)
      })
    const reading = read(() => parsed.resolve())
    await parsed.promise
    expect(transferred.mock.calls.filter(([command]) => command.op === 'read-batch')).toHaveLength(
      0
    )
    admission.resolve()
    expect(await reading).toMatchObject({ messageCount: 4 })
    expect(transferred.mock.calls.filter(([command]) => command.op === 'read-batch')).toHaveLength(
      0
    )
    transferred.mockRestore()
    expect(accepted()).toEqual({
      session: { id: 1, content_hash_count: 4 },
      messages: { n: 4 },
      hits: { n: 2 }
    })
  } finally {
    vi.restoreAllMocks()
    unregister?.()
    store?.close()
    await store?.retired()
    await rm(root, { recursive: true, force: true })
  }
})
