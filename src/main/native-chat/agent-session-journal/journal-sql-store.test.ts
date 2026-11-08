import { StructuredAgentSessionJournalProjections } from '../agent-session-wire/observations/structured-agent-session-status-journal-projection'
import { StructuredAgentSessionStatusFeed } from '../agent-session-wire/observations/structured-agent-session-status-feed'
import type { StatusFeedSession } from '../agent-session-wire/observations/structured-agent-session-status-feed-deps'
import type { JournalWorkAuthority } from './journal-observer-read'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { openStructuredAgentSessionSqlJournalDatabase } from '../../runtime/agent-session/structured-agent-session-journal-open'
import { journalDatabasePath } from './database/journal-host-database'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import { SqlAgentSessionJournal } from './journal-sql-store'
import type { JournalSqlStoreOperation } from './journal-sql-store'
import { JournalHostFactsNeededError } from './journal-writer-host-facts'
import type { JournalOperationReceipt } from './writing/journal-row-writer'
import { CommandReceiptExistsError } from './writing/command-receipt-transaction'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from './journal-sql-worker-bundle.test-fixture'

const roots: string[] = []
const databases: JournalSqlDatabase[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(databases.splice(0).map((database) => database.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const identity = {
  sessionId: 'session',
  workspaceId: 'workspace',
  hostId: 'host',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread')
}

const item = (text: string): JournalSqlStoreOperation => ({
  kind: 'item',
  identity: { provider: 'orca', clientMessageId: 'item' },
  body: { kind: 'status', text },
  options: { fence: 1, turnScope: { kind: 'thread' } }
})

async function open(root: string) {
  const errors: unknown[] = []
  const opened = await openStructuredAgentSessionSqlJournalDatabase({
    stateDirectory: root,
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    logger: { warn: () => {}, error: (_message, fields) => errors.push(fields.error) }
  })
  databases.push(opened.journalDatabase)
  expect(errors).toEqual([])
  return opened
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'journal-sql-store-'))
  roots.push(root)
  const { journalDatabase: database, records } = await open(root)
  expect(records.records.size).toBe(0)
  const journal = await SqlAgentSessionJournal.open({ database, identity, now: () => 100 })
  return { root, database, journal }
}

function receipt(adopt: (committed: boolean) => void, draft = 'retained'): JournalOperationReceipt {
  return {
    write: () => {
      throw new Error('the host must never write a SQL receipt')
    },
    committed: () => {
      throw new Error('the host must settle the staged receipt')
    },
    stage: async () => ({
      effects: [
        {
          kind: 'store',
          insertOperationsIfAbsent: false,
          writes: {
            records: {
              upsert: [['session', JSON.stringify({ schemaVersion: 999, draft })]],
              remove: []
            },
            operations: { upsert: [], remove: [] },
            retiredClaimKeys: null,
            sessionTabs: null
          }
        },
        {
          kind: 'receipt',
          scope: { kind: 'global' },
          receipt: {
            operationId: 'operation',
            sessionId: 'session',
            callerKey: 'caller',
            method: 'agentSession.send',
            fingerprint: 'fingerprint',
            acceptedAt: 100,
            status: 'accepted',
            result: { kind: 'journal-row', epoch: 'unassigned', sequence: 0 }
          },
          row: { at: 'first', kinds: ['item'], answer: 'journal-row' }
        }
      ],
      settle: (results) => adopt(results !== undefined)
    })
  }
}

it('adopts a row-bound receipt before publishing and reads the persisted revision after restart', async () => {
  const { root, database, journal } = await fixture()
  const opening = journal.openingCursor()
  expect(opening.sequence).toBe(1)
  expect(journal.wroteBeforeOpen(undefined)).toBe(false)
  expect(journal.wroteBeforeOpen(1)).toBe(true)
  let adopted = false
  const publications: boolean[] = []
  journal.observeCommits(() => publications.push(adopted))
  await journal.write(item('first'), () => ({
    receipt: receipt((committed) => {
      adopted = committed
    })
  }))
  expect(publications).toEqual([true])
  expect(journal.openingCursor()).toEqual(opening)
  expect(journal.cursor().sequence).toBe(2)
  expect(journal.wroteBeforeOpen(2)).toBe(false)
  expect(await database.readCommandReceipt({ kind: 'global' }, 'operation')).toMatchObject({
    verdict: 'readable',
    receipt: { result: { kind: 'journal-row', sequence: 2 } }
  })
  const revision = journal.write(item('revised'))
  const reading = journal.readInOrder((reads) => reads.item('orca:item'))
  const closed = journal.close()
  await expect(journal.write(item('after-close'))).rejects.toMatchObject({ code: 'journal_closed' })
  await revision
  expect(await reading).toMatchObject({ revision: 2, body: { text: 'revised' } })
  await closed
  await database.close()
  const reopened = await open(root)
  const next = await SqlAgentSessionJournal.open({ database: reopened.journalDatabase, identity })
  expect(next.wroteBeforeOpen(2)).toBe(true)
  expect(next.openingCursor().sequence).toBe(3)
  expect(next.observationHandle()).not.toBe(journal.observationHandle())
  expect(await next.reads.item('orca:item')).toMatchObject({
    revision: 2,
    body: { text: 'revised' }
  })
})

it('discards staged adoption and the row together when a receipt conflicts', async () => {
  const { database, journal } = await fixture()
  await journal.write(item('retained'), () => ({ receipt: receipt(() => {}) }))
  let adopted = true
  await expect(
    journal.write(item('must roll back'), () => ({
      receipt: receipt((committed) => {
        adopted = committed
      }, 'must roll back')
    }))
  ).rejects.toBeInstanceOf(CommandReceiptExistsError)
  expect(adopted).toBe(false)
  expect(await journal.reads.item('orca:item')).toMatchObject({
    revision: 1,
    body: { text: 'retained' }
  })
  expect(await database.readCommandReceipt({ kind: 'global' }, 'operation')).toMatchObject({
    verdict: 'readable',
    receipt: { result: { sequence: 2 } }
  })
  expect((await database.loadRecords()).unreadableRecords.get('session')).toEqual({
    reason: 'unsupported_schema',
    raw: { schemaVersion: 999, draft: 'retained' }
  })
})

it('releases a rolled-back stage before answering host facts and keeps the retry ahead of later commands', async () => {
  const { database, journal } = await fixture()
  await database.serialize('session', (writer) => {
    vi.spyOn(writer, 'write').mockRejectedValueOnce(
      new JournalHostFactsNeededError({
        rewound: { cursor: { epoch: 'proof', sequence: 8 }, cancel: null }
      })
    )
  })
  let released = false
  let adopted = false
  const retry = journal.write(
    item('retried'),
    () => ({
      receipt: receipt((committed) => {
        released = !committed
      })
    }),
    (_context, needs) => {
      expect(released).toBe(true)
      return {
        facts: { rewound: needs.rewound },
        receipt: receipt((committed) => {
          adopted = committed
        })
      }
    }
  )
  const next = journal.write(item('later'))
  await retry
  expect(adopted).toBe(true)
  await next
  expect(await journal.reads.item('orca:item')).toMatchObject({
    revision: 2,
    body: { text: 'later' }
  })
})

it('returns unanswered host-fact requests without replaying the command', async () => {
  const { database, journal } = await fixture()
  const needed = new JournalHostFactsNeededError({
    rewound: { cursor: { epoch: 'proof', sequence: 8 }, cancel: null }
  })
  await database.serialize('session', (writer) => {
    vi.spyOn(writer, 'write').mockRejectedValueOnce(needed)
  })
  let adopted = true
  await expect(
    journal.write(item('unanswered'), () => ({
      receipt: receipt((committed) => {
        adopted = committed
      })
    }))
  ).rejects.toBe(needed)
  expect(adopted).toBe(false)
  await journal.write(item('later'))
  expect(await journal.reads.item('orca:item')).toMatchObject({
    revision: 1,
    body: { text: 'later' }
  })
})

it('preserves a corrupt database on worker startup refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-sql-startup-'))
  roots.push(root)
  const path = journalDatabasePath(root)
  const bytes = Buffer.from('not a database '.repeat(512))
  await writeFile(path, bytes)
  await expect(open(root)).rejects.toMatchObject({
    refusal: { details: { reason: 'journalCorrupt' } }
  })
  expect(await readFile(path)).toEqual(bytes)
})

it('discards row-free authority changes before publishing an asynchronous observer answer', async () => {
  const { journal } = await fixture()
  const projections = new StructuredAgentSessionJournalProjections()
  let revision = 0
  const held: string[] = []
  const capture = () => {
    const authority: JournalWorkAuthority = {
      handle: journal.observationHandle(),
      record: {
        currentFence: 1,
        ownerObservation: { claimStatus: 'live', unreconciled: false, handoffStage: null }
      },
      child: { fence: 1, heldSends: held },
      handingOver: [],
      continuingUnadmitted: [],
      finalizing: [],
      openedThrough: journal.openingCursor(),
      reopenFloor: null,
      operationalRevision: revision,
      stopRevision: 0,
      stop: null
    }
    return { authority, contextId: null }
  }
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const read = journal.reads.observer.bind(journal.reads)
  vi.spyOn(journal.reads, 'observer').mockImplementationOnce(async (input) => {
    const result = await read(input)
    reached.resolve()
    await release.promise
    return result
  })
  let invalidated = false
  const pending = projections.readSql(journal, capture, () => {
    invalidated = true
  })
  await reached.promise
  revision = 1
  held.push('new-live-owner')
  release.resolve()
  expect(await pending).toBeNull()
  expect(invalidated).toBe(true)
  const current = await projections.readSql(journal, capture, () => {})
  expect(current).toMatchObject({
    workRevision: 1,
    authority: { child: { heldSends: ['new-live-owner'] } }
  })
  held.push('later-owner')
  expect(current?.authority?.child?.heldSends).toEqual(['new-live-owner'])
  expect(await projections.readSql(journal, capture, () => {})).toMatchObject({
    authority: { child: { heldSends: ['later-owner', 'new-live-owner'] } }
  })
})

it('publishes SQL status only with recaptured live owners through the existing refresh path', async () => {
  const { journal } = await fixture()
  await journal.write({
    kind: 'item',
    identity: { provider: 'orca', clientMessageId: 'prompt' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Read my chat' }] },
    options: { fence: 0, turnScope: { kind: 'thread' } }
  })
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'turn' },
    { kind: 'turn', turnId: 'turn', state: 'running', userItemId: 'orca:prompt' },
    { fence: 0, turnScope: { kind: 'thread' } }
  )
  await journal.appendStopEvent({ reason: 'user-stop' }, 0)
  const held = new Set<string>()
  const session: StatusFeedSession = {
    journal,
    params: {
      provider: 'codex',
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace',
        workspaceKind: 'git-worktree'
      }
    },
    child: { fence: 0, phase: 'ready', generation: 'generation', heldSends: () => held }
  }
  const logger = { warn: vi.fn(), error: vi.fn() }
  const feed = new StructuredAgentSessionStatusFeed({
    sessions: new Map([['session', session]]),
    getConversation: () => null,
    now: () => 999,
    logger
  })
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const published = Promise.withResolvers<void>()
  const read = journal.reads.observer.bind(journal.reads)
  vi.spyOn(journal.reads, 'observer').mockImplementationOnce(async (input) => {
    const result = await read(input)
    reached.resolve()
    await release.promise
    return result
  })
  const observations: unknown[] = []
  const pending = feed.publish('session', journal, { replay: true }, (projection) => {
    observations.push({
      revision: projection.workRevision,
      held: projection.authority?.child?.heldSends,
      stopping: projection.stopping
    })
    published.resolve()
  })
  await reached.promise
  expect(feed.readPublished('session')).toBeUndefined()
  session.operationalRevision = 1
  held.add('held-without-row')
  await journal.stopMarks.beginSettle(true)
  release.resolve()
  await pending
  await published.promise
  expect(observations).toEqual([{ revision: 1, held: ['held-without-row'], stopping: true }])
  expect(feed.readPublished('session')).toMatchObject({
    latestPrompt: 'Read my chat',
    status: 'working',
    stopping: true,
    updatedAt: 100
  })
  expect(logger.warn).not.toHaveBeenCalled()
})
