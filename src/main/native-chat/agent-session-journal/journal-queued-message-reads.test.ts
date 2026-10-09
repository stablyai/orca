import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { readQueuePublication } from '../agent-session-wire/structured-agent-session-queued-publication'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { JournalQueuedMessages } from './journal-queued-messages'
import type { AgentSessionJournal } from './journal-store'

const SESSION = 'queue-read-integration'
const journals = createTrackedJournalOpener()
let root: string
let journal: AgentSessionJournal

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function queue(messageId: string) {
  return journal.queuedMessages.insert({
    messageId,
    body: message(messageId),
    fingerprint: `fp-${messageId}`,
    hostInstance: 'host'
  })
}

function publication() {
  return readQueuePublication(journal, () => ({ record: null, fence: 0 }))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-queue-reads-'))
  journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'claude',
      providerHandle: claudeProviderHandle('native', null)
    },
    stateDirectory: root,
    mintEpoch: () => 'epoch'
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

it('journal gates and the transactional consume recheck never select or parse draft bodies', async () => {
  await queue('head')
  await queue('tail')
  const db = openTestJournalHostDatabase(root).db
  const prepare = vi.spyOn(db, 'prepare')
  const parse = vi.spyOn(JSON, 'parse')
  expect(journal.queuedMessages.nextSendable()?.messageId).toBe('head')
  expect(journal.queuedMessages.pauses()).toEqual([])
  expect(journal.queuedMessages.awaitReopenMark()).toBe(true)
  expect(journal.queuedMessages.settlementOwed()).toBe(false)
  expect(journal.queuedMessages.deliveredByEchoOwed()).toBe(false)
  db.exec('BEGIN IMMEDIATE')
  try {
    journal.queuedMessages.consumeInTransaction(db, {
      messageId: 'head',
      expect: 'waiting',
      settledByOp: null,
      consumedAs: 'handoff',
      yieldsToPause: true
    })
    expect(journal.queuedMessages.nextSendable()?.messageId).toBe('tail')
  } finally {
    db.exec('ROLLBACK')
    journal.queuedMessages.invalidate()
  }
  expect(journal.queuedMessages.nextSendable()?.messageId).toBe('head')
  expect(parse).not.toHaveBeenCalled()
  for (const [sql] of prepare.mock.calls.filter(([sql]) => sql.startsWith('SELECT'))) {
    expect(sql.split('FROM')[0]).not.toMatch(/body_json|returned_rejection/)
  }
})

it('v1 publication parses only unsettled bodies, once per queue revision, with unchanged output', async () => {
  await queue('withdrawn')
  await journal.queuedMessages.withdraw({ messageIds: ['withdrawn'], settledByOp: 'op' })
  await queue('waiting')
  await queue('returned')
  const db = openTestJournalHostDatabase(root).db
  db.prepare(
    "UPDATE queued_messages SET state = 'returned', returned_reason = 'refused' WHERE message_id = 'returned'"
  ).run()
  const list = vi.spyOn(JournalQueuedMessages.prototype, 'list')
  const parse = vi.spyOn(JSON, 'parse')
  const first = publication()
  expect(first.queuedMessages).toEqual([
    { messageId: 'waiting', position: 2, body: message('waiting'), state: 'waiting' },
    {
      messageId: 'returned',
      position: 3,
      body: message('returned'),
      state: 'returned',
      returnedReason: 'refused'
    }
  ])
  expect(publication()).toBe(first)
  expect(list).toHaveBeenCalledTimes(1)
  expect(parse).toHaveBeenCalledTimes(2)
  parse.mockRestore()
  await queue('new')
  expect(publication().queuedMessages.map((row) => row.messageId)).toEqual([
    'waiting',
    'returned',
    'new'
  ])
  expect(list).toHaveBeenCalledTimes(2)
})

it('a publication read inside a rolled-back consume cannot survive invalidation', async () => {
  await queue('head')
  const db = openTestJournalHostDatabase(root).db
  const first = publication()
  const revision = journal.queuedMessages.revision()
  db.exec('BEGIN IMMEDIATE')
  try {
    journal.queuedMessages.consumeInTransaction(db, {
      messageId: 'head',
      expect: 'waiting',
      consumedAs: 'handoff',
      settledByOp: null,
      yieldsToPause: true
    })
    expect(publication().queuedMessages).toEqual([])
    expect(journal.queuedMessages.list()).toEqual([])
  } finally {
    db.exec('ROLLBACK')
    journal.queuedMessages.invalidate()
  }
  expect(journal.queuedMessages.revision()).toBeGreaterThan(revision)
  expect(publication()).toEqual(first)
  expect(journal.queuedMessages.list().map((row) => row.messageId)).toEqual(['head'])
})

it('does not derive pauses when no readable card is waiting', async () => {
  await queue('returned')
  const db = openTestJournalHostDatabase(root).db
  db.prepare("UPDATE queued_messages SET state = 'returned'").run()
  const pauses = vi.spyOn(journal.queuedMessages, 'pauses')
  expect(journal.queuedMessages.nextSendable()).toBeNull()
  expect(pauses).not.toHaveBeenCalled()
})
