// Damage fails the chat's load, and nothing is deleted.
//
// A row this build cannot parse, a row numbered against its key, a gap in the sequence and an epoch
// without its first row are each damage. The open refuses the chat as history that cannot be
// loaded, and every stored row is where it was.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type Database from '../../sqlite/sync-database'
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
const journals = createTrackedJournalOpener()

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

function withJournalDatabase<T>(run: (db: Database.Database) => T): T {
  const opened = openTestJournalHostDatabase(root)
  try {
    return run(opened.db)
  } finally {
    opened.close()
  }
}

function storedRows(): { seq: number; rowJson: string }[] {
  return withJournalDatabase((db) => liveTestJournalRows(db, IDENTITY.sessionId))
}

/** A chat of an epoch row and five messages: sequences 1 to 6. */
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
    withJournalDatabase(damage)
    const before = storedRows()

    await expect(open()).rejects.toMatchObject(UNLOADABLE)
    await expect(open()).rejects.toMatchObject(UNLOADABLE)

    expect(storedRows()).toEqual(before)
  })

  it('names where the damage starts', async () => {
    await writeChat()
    withJournalDatabase((db) => deleteTestJournalRow(db, IDENTITY.sessionId, 4))

    expect(loadTestJournal(root, IDENTITY.sessionId)).toMatchObject({
      newer: null,
      damage: { sequence: 4, cause: 'sequence-gap' }
    })
  })

  it("reads past damage to a newer build's row, which fails the load as a newer Orca's instead", async () => {
    await writeChat()
    withJournalDatabase((db) => {
      updateTestJournalRowJson(db, IDENTITY.sessionId, 3, '}{')
      const newer = { ...JSON.parse(storedRowJson(db, 5)), kind: 'checkpoint' }
      updateTestJournalRowJson(db, IDENTITY.sessionId, 5, JSON.stringify(newer))
    })
    const before = storedRows()

    await expect(open()).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
    expect(storedRows()).toEqual(before)
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
  // TypeScript accepts it; the persisted reader rejects a call id that is only spaces.
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
    expect(storedRows().map((row) => row.seq)).toEqual([1, 2, 3])
  })

  it('rolls back a whole epoch replacement that holds one, keeping the epoch it would replace', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('kept'), scope)
    // The open journal's own database: closing it here would close the journal's too.
    const liveRows = () =>
      liveTestJournalRows(openTestJournalHostDatabase(root).db, IDENTITY.sessionId)
    const before = liveRows()

    await expect(
      journal.replaceEpochItems('legacy_import', 1, [
        { identity: item(5), body: body('replacement') },
        { identity: item(6), body: blankCallId }
      ])
    ).rejects.toMatchObject({ code: 'journal_row_rejected' })

    expect(liveRows()).toEqual(before)
    await journal.appendItem(item(1), body('still writable'), scope)
    await journal.close()
    await expect(open()).resolves.toBeTruthy()
  })
})

describe('an epoch named with no rows at all', () => {
  // A crash inside an older build's repair: the suffix deleted, its new epoch not yet published.
  it('is founded afresh on open, with nothing deleted, and takes writes', async () => {
    await writeChat()
    withJournalDatabase((db) => {
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
