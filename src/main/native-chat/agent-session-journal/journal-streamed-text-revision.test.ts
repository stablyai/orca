import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { codexImageItemBody } from '../../codex/codex-image-item-translation'
import { journalPragmaNumber } from './journal-database'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { openAgentSessionJournal } from './journal-store-factory'

import { createDeferredStructuredAgentSessionEventSink } from '../agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../agent-session-wire/structured-agent-session-logger-test-support'
import { createProviderTimelineAssembler } from '../agent-session-timeline/provider-timeline-assembler'
import { providerTimelineSink } from '../agent-session-timeline/provider-timeline-plan'
import * as attachmentReferences from '../agent-session-attachments/agent-session-attachment-references'
import { JournalGoalAttachmentInverse } from './journal-goal-attachment-inverse'
import { formatNativeChatFileReference } from '../../../shared/agent-image-paste'
import type { JournalOperationReceipt } from './journal-row-writer'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES } from './journal-row-schema'

const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-streamed-revision-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

const text = (role: 'assistant' | 'user', value: string): AgentJournalMessageItem => ({
  kind: 'message',
  role,
  blocks: [{ type: 'text', text: value }]
})

it('keeps image and goal transitions FULL, streams text at NORMAL, and restores FULL', async () => {
  const database = openTestJournalHostDatabase(root)
  const levels: number[] = []
  database.transaction((db) => levels.push(journalPragmaNumber(db, 'synchronous')), true)
  levels.push(journalPragmaNumber(database.db, 'synchronous'))
  database.transaction((db) => levels.push(journalPragmaNumber(db, 'synchronous')))
  expect(() =>
    database.transaction(() => {
      throw new Error('rolled back')
    }, true)
  ).toThrow('rolled back')
  levels.push(journalPragmaNumber(database.db, 'synchronous'))
  expect(levels).toEqual([1, 2, 2, 2])
  const journal = await openAgentSessionJournal({
    database,
    identity: {
      sessionId: 'chat',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'codex',
      providerHandle: null
    }
  })
  levels.length = 0
  const exec = database.db.exec.bind(database.db)
  const rollbacks: number[] = []
  vi.spyOn(database.db, 'exec').mockImplementation((sql) => {
    if (sql === 'COMMIT') {
      levels.push(journalPragmaNumber(database.db, 'synchronous'))
    }
    if (sql === 'ROLLBACK') {
      rollbacks.push(journalPragmaNumber(database.db, 'synchronous'))
    }
    exec(sql)
  })
  const image = { id: 'image', type: 'imageGeneration' }
  for (const body of [
    text('assistant', 'Generating image'),
    codexImageItemBody({ ...image, status: 'inProgress' }),
    codexImageItemBody({ ...image, status: 'completed', result: 'AAAA' }),
    text('assistant', 'Image preview unavailable'),
    { ...text('assistant', 'Goal'), sentAs: 'goal' as const },
    text('assistant', 'Goal reached')
  ]) {
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 1 },
      body,
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  expect(levels).toEqual([2, 1, 2, 2, 2, 2])
  expect(journalPragmaNumber(database.db, 'synchronous')).toBe(2)
  levels.length = 0
  for (const options of [
    { recovered: true as const },
    { ownerFence: 2 },
    { executionOwner: 2 },
    { agentId: 'child', producerKind: 'agent' as const }
  ]) {
    await journal.appendSteps([
      {
        kind: 'item',
        resolve: () => ({
          identity: { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 1 },
          body: text('assistant', 'control transition')
        }),
        options: { fence: 2, turnScope: AGENT_JOURNAL_THREAD_SCOPE, ...options }
      }
    ])
  }
  // Existing items retain creation provenance; a caller's ownerFence hint changes no stored owner.
  expect(levels).toEqual([2, 1, 2, 2])
  const identity = { provider: 'orca' as const, clientMessageId: 'failed-stream' }
  await journal.appendItem(identity, text('assistant', 'before failure'), {
    fence: 2,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  database.db.exec(
    "CREATE TRIGGER reject_stream BEFORE INSERT ON journal_rows BEGIN SELECT RAISE(ABORT, 'stream insert failed'); END"
  )
  await expect(
    journal.appendSteps([
      {
        kind: 'item',
        resolve: () => ({ identity, body: text('assistant', 'failed') }),
        options: { fence: 2, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      }
    ])
  ).rejects.toThrow('stream insert failed')
  expect(rollbacks).toEqual([1])
  expect(journalPragmaNumber(database.db, 'synchronous')).toBe(2)
  expect(journal.snapshot().items.at(-1)?.body).toEqual(text('assistant', 'before failure'))
  database.db.exec('DROP TRIGGER reject_stream')
  levels.length = 0
  await journal.appendItem(identity, text('assistant', 'retry'), {
    fence: 2,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  expect(levels).toEqual([1])
  expect(journal.snapshot().items.at(-1)?.body).toEqual(text('assistant', 'retry'))
  await journal.close()
})

function openJournal(sessionId = 'stream') {
  return journals.open({
    stateDirectory: root,
    identity: {
      sessionId,
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'grok',
      providerHandle: null
    }
  })
}

function commitLevels() {
  const { db } = openTestJournalHostDatabase(root)
  const levels: number[] = []
  const exec = db.exec.bind(db)
  vi.spyOn(db, 'exec').mockImplementation((sql) => {
    if (sql === 'COMMIT') {
      levels.push(journalPragmaNumber(db, 'synchronous'))
    }
    exec(sql)
  })
  return levels
}

async function uploadedInput() {
  const id = randomUUID()
  const path = join(attachmentReferences.agentSessionAttachmentStoreRoot(root), id, 'source.txt')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'retained input')
  return { id, body: text('user', formatNativeChatFileReference(path)) }
}

it.each([1, 10])(
  'commits %i real assembler windows at NORMAL with no attachment effects',
  async (count) => {
    const journal = await openJournal()
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging('stream'))
    deferred.bind({ journal, fence: 1, publish: () => {} })
    const sink = providerTimelineSink(deferred.sink)
    if (!sink) {
      throw new Error('missing production transition sink')
    }
    const windows = new Set<() => void>()
    const assembler = createProviderTimelineAssembler({
      sink,
      sessionId: 'stream',
      agent: 'grok',
      generation: 'g1',
      namespace: 'p1',
      schedule: (run) => {
        windows.add(run)
        return () => windows.delete(run)
      }
    })
    const flush = async () => {
      const due = [...windows]
      windows.clear()
      due.forEach((run) => run())
      await deferred.drained()
    }
    const levels = commitLevels()
    const extraction = vi.spyOn(attachmentReferences, 'agentSessionAttachmentReferences')
    const acquired = vi.spyOn(JournalGoalAttachmentInverse.prototype, 'acquired')
    const delta = () =>
      assembler.apply({
        type: 'text.delta',
        item: { id: 'reply' },
        channel: 'assistant',
        text: 'hello '
      })
    try {
      delta()
      await flush()
      expect(levels).toEqual([2])
      levels.length = 0
      for (let n = 0; n < count; n++) {
        expect(delta().admission).toEqual({ accepted: true })
        await flush()
      }
      expect(levels).toEqual(Array(count).fill(1))
      expect(extraction).not.toHaveBeenCalled()
      expect(acquired).not.toHaveBeenCalled()
      expect(journal.snapshot().items).toHaveLength(1)
      expect(journal.snapshot().items[0]?.body).toEqual(
        text('assistant', 'hello '.repeat(count + 1))
      )
      expect(journalPragmaNumber(openTestJournalHostDatabase(root).db, 'synchronous')).toBe(2)
      process.stdout.write(
        `pr34654-stream-contract ${JSON.stringify({ count, levels, extractions: extraction.mock.calls.length, acquired: acquired.mock.calls.length })}\n`
      )
      levels.length = 0
      assembler.apply({ type: 'turn.open', turn: 'turn', at: 1 })
      assembler.apply({ type: 'turn.end', turn: 'turn', state: 'completed', at: 2 })
      await flush()
      expect(levels.length).toBeGreaterThan(0)
      expect(levels.every((level) => level === 2)).toBe(true)
      levels.length = 0
      const input = await uploadedInput()
      await journal.appendClaimingAttachments(
        { provider: 'orca', clientMessageId: 'goal' },
        { ...input.body, sentAs: 'goal' },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      expect(levels).toEqual([2])
      expect(acquired).toHaveBeenCalledTimes(1)
    } finally {
      assembler.dispose()
      deferred.close()
    }
  }
)

it('resolves/builds once after preceding writes and preserves actual output and external receipt durability', async () => {
  const journal = await openJournal()
  const identity = { provider: 'orca' as const, clientMessageId: 'dynamic' }
  let release = () => {}
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const held = journal.readInOrder(() => barrier)
  const levels = commitLevels()
  const preceding = journal.appendItem(identity, text('assistant', 'first'), {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  const resolve = vi.fn(() => {
    expect(journal.snapshot().items[0]?.body).toEqual(text('assistant', 'first'))
    return { identity, body: text('assistant', 'second') }
  })
  const following = journal.appendResolvedItem(resolve, {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  release()
  await Promise.all([held, preceding, following])
  expect(resolve).toHaveBeenCalledTimes(1)
  expect(levels).toEqual([2, 1])
  levels.length = 0
  const empty = vi.fn(() => null)
  expect(
    await journal.appendResolvedItem(empty, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  ).toBeNull()
  expect(empty).toHaveBeenCalledTimes(1)
  expect(levels).toEqual([])

  const { db } = openTestJournalHostDatabase(root)
  db.exec('CREATE TABLE receipt_fact (sequence INTEGER)')
  const write = vi.fn<JournalOperationReceipt['write']>((connection, row) => {
    if (!row) {
      throw new Error('missing receipt target')
    }
    connection.prepare('INSERT INTO receipt_fact VALUES (?)').run(row.seq)
  })
  const committed = vi.fn(() =>
    expect(db.prepare('SELECT sequence FROM receipt_fact').all()).toHaveLength(1)
  )
  const result = await journal.appendItem(
    identity,
    text('assistant', 'durable receipt'),
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE },
    { write, committed }
  )
  expect(levels).toEqual([2])
  expect(db.prepare('SELECT sequence FROM receipt_fact').get()?.sequence).toBe(
    result.cursor.sequence
  )
  expect(write).toHaveBeenCalledTimes(1)
  expect(committed).toHaveBeenCalledTimes(1)
  const huge = 'x'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES)
  for (const mode of ['ordinary', 'planned', 'step'] as const) {
    const body = text('assistant', `${huge}${mode}`)
    const plan = vi.fn(() => [
      { kind: 'item' as const, identity, body, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    ])
    levels.length = 0
    if (mode === 'ordinary') {
      await journal.appendLifecycleBatch({ settlementId: mode, fence: 1, mutations: plan() })
    }
    if (mode === 'planned') {
      await journal.appendPlannedLifecycleBatch({
        settlementId: mode,
        fence: 1,
        plan: () => ({ mutations: plan(), dispatches: [] })
      })
    }
    if (mode === 'step') {
      await journal.appendSteps([
        { kind: 'settlement', batch: { settlementId: mode, fence: 1, resolve: plan } }
      ])
    }
    expect(plan).toHaveBeenCalledTimes(1)
    expect(levels).toEqual([1])
    expect(journal.snapshot().items[0]?.body).toEqual(body)
  }
  levels.length = 0
  expect(
    await journal.appendSteps([
      {
        kind: 'item',
        resolve: () => null,
        options: { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      }
    ])
  ).toEqual([false])
  await journal.appendPlannedLifecycleBatch({
    settlementId: 'empty',
    fence: 1,
    plan: () => ({ mutations: [], dispatches: [] })
  })
  expect(levels).toEqual([])
  await journal.appendLifecycleBatch({
    settlementId: 'envelope',
    fence: 1,
    mutations: [
      {
        kind: 'item',
        identity,
        body: text('assistant', 'settled'),
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ]
  })
  expect(levels).toEqual([2])
})

it.each([1, 10])(
  'protects %i actual independent inputs per writer without visiting prior history',
  async (count) => {
    const journal = await openJournal()
    const other = await openJournal('other')
    for (let n = 0; n < 10 * count; n++) {
      const identity = { provider: 'orca' as const, clientMessageId: `old-${n}` }
      await journal.appendItem(identity, text('user', 'old'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await other.appendItem(identity, text('user', 'unrelated'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    }
    const { db } = openTestJournalHostDatabase(root)
    const insertion = vi.spyOn(
      db.prepare(
        'INSERT OR IGNORE INTO agent_session_attachment_claims (upload_id, session_id, claimed_at) VALUES (?, ?, ?)'
      ),
      'run'
    )
    const extraction = vi.spyOn(attachmentReferences, 'agentSessionAttachmentReferences')
    const acquired = vi.spyOn(JournalGoalAttachmentInverse.prototype, 'acquired')
    const levels = commitLevels()
    for (const writer of [
      'direct',
      'resolved',
      'step',
      'batch',
      'planned',
      'submission',
      'queue'
    ] as const) {
      insertion.mockClear()
      extraction.mockClear()
      acquired.mockClear()
      levels.length = 0
      for (let n = 0; n < count; n++) {
        const { id, body } = await uploadedInput()
        const identity = { provider: 'orca' as const, clientMessageId: `${writer}-${n}` }
        const resolve = vi.fn(() => ({ identity, body }))
        if (writer === 'direct') {
          await journal.appendItem(identity, body, {
            fence: 1,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          })
        }
        if (writer === 'resolved') {
          await journal.appendResolvedItem(resolve, {
            fence: 1,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          })
          expect(resolve).toHaveBeenCalledTimes(1)
        }
        if (writer === 'step') {
          await journal.appendSteps([
            { kind: 'item', resolve, options: { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE } }
          ])
          expect(resolve).toHaveBeenCalledTimes(1)
        }
        if (writer === 'batch') {
          await journal.appendLifecycleBatch({
            settlementId: identity.clientMessageId,
            fence: 1,
            mutations: [{ kind: 'item', identity, body, turnScope: AGENT_JOURNAL_THREAD_SCOPE }]
          })
        }
        if (writer === 'planned') {
          await journal.appendPlannedLifecycleBatch({
            settlementId: identity.clientMessageId,
            fence: 1,
            plan: () => ({
              mutations: [{ kind: 'item', identity, body, turnScope: AGENT_JOURNAL_THREAD_SCOPE }],
              dispatches: []
            })
          })
        }
        if (writer === 'submission') {
          await journal.appendSubmission({
            clientMessageId: identity.clientMessageId,
            payloadFingerprint: 'fp',
            body,
            fence: 1,
            origin: 'host'
          })
        }
        if (writer === 'queue') {
          await journal.queuedMessages.insert({ messageId: identity.clientMessageId, body })
        }
        expect(
          db
            .prepare(
              'SELECT upload_id FROM agent_session_attachment_claims WHERE upload_id = ? AND session_id = ?'
            )
            .all(id, 'stream')
        ).toHaveLength(1)
      }
      expect(insertion).toHaveBeenCalledTimes(count)
      expect(extraction).toHaveBeenCalledTimes(count)
      expect(acquired).toHaveBeenCalledTimes(count)
      expect(levels).toEqual(Array(count).fill(2))
      process.stdout.write(
        `pr34654-input-contract ${JSON.stringify({ writer, count, old: 10 * count, extractions: extraction.mock.calls.length, insertions: insertion.mock.calls.length, acquired: acquired.mock.calls.length })}\n`
      )
    }
  }
)
