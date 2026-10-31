import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import Database from '../../sqlite/sync-database'
import type { openAgentSessionJournal } from './journal-store-factory'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  loadTestJournal,
  liveTestJournalRows,
  updateTestJournalRowJson,
  deleteTestJournalRow,
  SAVED_BY_NEWER_ORCA
} from './journal-host-database-test-support'
import { journalOpenRefusalError } from './journal-open-failure'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}

const UNLOADABLE = {
  refusal: { code: 'agent_session_journal_unreadable', details: { reason: 'journalCorrupt' } }
}

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener({ legacyInputs: true })

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function body(value: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

function open(overrides: Partial<Parameters<typeof openAgentSessionJournal>[0]> = {}) {
  return journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => `epoch-${clock}`,
    ...overrides
  })
}

async function withJournalDatabase<T>(run: (db: Database.Database) => T): Promise<T> {
  const opened = openTestJournalHostDatabase(root)
  try {
    return run(opened.db)
  } finally {
    await opened.close()
  }
}

async function storedRows(): Promise<{ seq: number; rowJson: string }[]> {
  return withJournalDatabase((db) => liveTestJournalRows(db, IDENTITY.sessionId))
}

async function writeChat(): Promise<void> {
  const journal = await open()
  for (let ordinal = 0; ordinal < 5; ordinal += 1) {
    await journal.appendItem(item(ordinal), body(`m${ordinal}`), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
  await journal.close()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-damage-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('a damaged chat', () => {
  it.each([
    [
      'a row that is not a row',
      (db: Database.Database) => updateTestJournalRowJson(db, IDENTITY.sessionId, 3, '}{')
    ],
    [
      'a row of a known kind missing a field',
      (db: Database.Database) =>
        updateTestJournalRowJson(
          db,
          IDENTITY.sessionId,
          3,
          JSON.stringify({ ...JSON.parse(storedRowJson(db, 3)), itemId: 5 })
        )
    ],
    [
      'a row numbered against its key',
      (db: Database.Database) =>
        updateTestJournalRowJson(
          db,
          IDENTITY.sessionId,
          3,
          JSON.stringify({ ...JSON.parse(storedRowJson(db, 3)), seq: 9 })
        )
    ],
    [
      'a gap in the sequence',
      (db: Database.Database) => deleteTestJournalRow(db, IDENTITY.sessionId, 4)
    ],
    ['no epoch row', (db: Database.Database) => deleteTestJournalRow(db, IDENTITY.sessionId, 1)]
  ])('fails to load and keeps every row: %s', async (_name, damage) => {
    await writeChat()
    await withJournalDatabase(damage)
    const before = await storedRows()

    await expect(open()).rejects.toMatchObject(UNLOADABLE)
    await expect(open()).rejects.toMatchObject(UNLOADABLE)

    expect(await storedRows()).toEqual(before)
  })

  it('names where the damage starts', async () => {
    await writeChat()
    await withJournalDatabase((db) => deleteTestJournalRow(db, IDENTITY.sessionId, 4))

    expect(loadTestJournal(root, IDENTITY.sessionId)).toMatchObject({
      newer: null,
      damage: { sequence: 4, cause: 'sequence-gap' }
    })
  })

  it.each([1, 3])(
    "reads past damage at row %i to a newer build's row, which fails the load as a newer Orca's instead",
    async (damaged) => {
      await writeChat()
      await withJournalDatabase((db) => {
        updateTestJournalRowJson(db, IDENTITY.sessionId, damaged, '}{')
        const newer = { ...JSON.parse(storedRowJson(db, 5)), kind: 'checkpoint' }
        updateTestJournalRowJson(db, IDENTITY.sessionId, 5, JSON.stringify(newer))
      })
      const before = await storedRows()

      await expect(open()).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
      expect(await storedRows()).toEqual(before)
    }
  )
})

describe('a chat whose saved state cannot be read right now', () => {
  const outcomes = createTrackedJournalOpener()
  afterEach(async () => {
    vi.restoreAllMocks()
    await outcomes.closeAll()
  })

  it('refuses the open as unavailable on a transient read error, and the next open loads it', async () => {
    const options = {
      identity: IDENTITY,
      stateDirectory: root,
      now: () => (clock += 1),
      mintEpoch: () => `epoch-${clock}`
    }
    const journal = await outcomes.open(options)
    await journal.appendItem(item(0), body('kept'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.close()
    let failures = 1
    const prepare = Database.prototype.prepare
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database,
      sql: string
    ) {
      if (failures > 0 && sql.includes('FROM journal_outcomes')) {
        failures -= 1
        throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 })
      }
      return prepare.call(this, sql)
    })

    // As on main, the storage error reaches the host, which reports "unavailable, try again".
    const failure = await outcomes.open(options).then(
      () => null,
      (error: unknown) => error
    )
    expect(failure).toMatchObject({ code: 'ERR_SQLITE_ERROR' })
    expect(journalOpenRefusalError(failure)).toMatchObject({
      refusal: {
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalUnavailable' }
      }
    })
    expect(failures).toBe(0)
    const reopened = await outcomes.open(options)
    expect(reopened.snapshot().items.map((entry) => entry.body)).toEqual([body('kept')])
  })
})

function storedRowJson(db: Database.Database, seq: number): string {
  const row = liveTestJournalRows(db, IDENTITY.sessionId).find((entry) => entry.seq === seq)
  if (!row) {
    throw new Error(`no row at ${seq}`)
  }
  return row.rowJson
}

describe('a row the reader would reject', () => {
  const blankCallId: AgentJournalItemBody = {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'tool-call', name: 'Bash', input: null, callId: '   ' }]
  }
  const scope = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

  it('is refused when it is written, and the chat still loads with every other row', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('before'), scope)
    await expect(journal.appendItem(item(1), blankCallId, scope)).rejects.toMatchObject({
      code: 'journal_row_rejected'
    })
    await journal.appendItem(item(2), body('after'), scope)
    await journal.close()

    const reopened = await open()
    expect(reopened.snapshot().items.map((entry) => entry.body)).toEqual([
      body('before'),
      body('after')
    ])
    expect((await storedRows()).map((row) => row.seq)).toEqual([1, 2, 3])
  })

  it('rolls back a whole epoch replacement that holds one, keeping the epoch it would replace', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('kept'), scope)
    // Closing the shared test connection would also close the live journal.
    const liveRows = () =>
      liveTestJournalRows(openTestJournalHostDatabase(root).db, IDENTITY.sessionId)
    const before = liveRows()

    await expect(
      journal.replaceEpochItems('legacy_import', 1, [
        { identity: item(5), body: body('replacement'), ownerFence: 1 },
        { identity: item(6), body: blankCallId, ownerFence: 1 }
      ])
    ).rejects.toMatchObject({ code: 'journal_row_rejected' })

    expect(liveRows()).toEqual(before)
    await journal.appendItem(item(1), body('still writable'), scope)
    await journal.close()
    await expect(open()).resolves.toBeTruthy()
  })
})

describe('an epoch named with no rows at all', () => {
  it('is founded afresh on open, with nothing deleted, and takes writes', async () => {
    await writeChat()
    await withJournalDatabase((db) => {
      for (const row of liveTestJournalRows(db, IDENTITY.sessionId)) {
        deleteTestJournalRow(db, IDENTITY.sessionId, row.seq)
      }
    })
    expect(loadTestJournal(root, IDENTITY.sessionId)).toMatchObject({
      newer: null,
      damage: null,
      state: { lastSequence: 0 }
    })

    const journal = await open()
    await journal.appendItem(item(0), body('after'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.close()

    const reopened = await open()
    expect(reopened.snapshot().items.map((entry) => entry.body)).toEqual([body('after')])
  })
})
