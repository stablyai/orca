// A repair drops what it cannot replay, and says so.
//
// Two things make a suffix unreplayable: a row this build cannot parse, and a
// sequence gap that makes every later row unanchored. The rejected suffix is
// DELETED; the load reports `corrupt`, and recovery rebuilds the epoch from
// provider history. Every case here asserts the same two halves: the live epoch
// holds only the replayable prefix, AND the epoch stays anchored so nothing
// replays a repaired journal as a clean timeline.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import { journalDatabaseFile } from './journal-paths'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
import { loadJournal } from './journal-open'
import type { openAgentSessionJournal } from './journal-store-factory'
import { createTrackedJournalOpener } from './journal-store-test-open'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function tick(): number {
  clock += 1
  return clock
}

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function body(value: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

function open(overrides: Partial<Parameters<typeof openAgentSessionJournal>[0]> = {}) {
  return journals.open({
    identity: IDENTITY,
    journalDir: root,
    now: tick,
    mintEpoch: () => `epoch-${clock}`,
    ...overrides
  })
}

async function withJournalDatabase(run: (db: Database.Database) => void): Promise<void> {
  const opened = openJournalDatabase(journalDatabaseFile(root))
  try {
    run(opened.db)
  } finally {
    opened.db.close()
  }
}

/** The row replay anchors on, parsed exactly as replay parses it. */
function firstLiveRow(): Promise<JournalRow | null> {
  let row: JournalRow | null = null
  return withJournalDatabase((db) => {
    const stored = db.prepare('SELECT row_json FROM journal_rows ORDER BY seq LIMIT 1').get() as
      | { row_json: string }
      | undefined
    const parsed = stored ? parseJournalRow(stored.row_json) : null
    row = parsed?.ok ? parsed.row : null
  }).then(() => row)
}

function liveSequences(): Promise<number[]> {
  let sequences: number[] = []
  return withJournalDatabase((db) => {
    sequences = (
      db.prepare('SELECT seq FROM journal_rows ORDER BY seq').all() as { seq: number }[]
    ).map((row) => row.seq)
  }).then(() => sequences)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-repair-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('a malformed row', () => {
  it('keeps the readable prefix live and drops the rest of the epoch', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('readable'), { fence: 1 })
    await journal.appendItem(item(1), body('unreadable'), { fence: 1 })
    await journal.appendItem(item(2), body('after the fault'), { fence: 1 })
    await journal.close()
    await withJournalDatabase((db) => {
      db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = ?').run('{"not":"a row"}', 3)
    })

    const reopened = await open()
    expect(reopened.repair.malformedRows).toBe(1)
    // 1..2 is the surviving prefix; 3 is the disclosure the repair appends.
    expect(await liveSequences()).toEqual([1, 2, 3])
  })

  it('discloses the line it could not read', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('readable'), { fence: 1 })
    await journal.appendItem(item(1), body('later'), { fence: 1 })
    await journal.close()
    await withJournalDatabase((db) => {
      db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = ?').run('}{', 2)
    })

    const reopened = await open()
    const disclosure = reopened
      .snapshot()
      .items.map((entry) => entry.body)
      .find((entry) => entry.kind === 'status')
    expect(disclosure).toMatchObject({ kind: 'status' })
    expect(disclosure && 'text' in disclosure ? disclosure.text : '').toContain(
      '1 journal line could not be read'
    )
  })
})

describe('a sequence gap', () => {
  it('drops every row after the hole and reports the epoch corrupt', async () => {
    const journal = await open()
    for (let ordinal = 0; ordinal < 5; ordinal += 1) {
      await journal.appendItem(item(ordinal), body(`m${ordinal}`), { fence: 1 })
    }
    await journal.close()
    // Sequence 1 is the epoch row, so the items occupy 2..6. Removing 4 leaves
    // 5 and 6 valid but unanchored.
    await withJournalDatabase((db) => {
      db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(4)
    })

    const reopened = await open()
    expect(await liveSequences()).toEqual([1, 2, 3])
    expect(reopened.repair).toEqual({ malformedRows: 0 })
    expect(reopened.snapshot().items.map((entry) => entry.body)).toEqual([body('m0'), body('m1')])
  })

  // The prefix survives, so there is no emptied epoch to re-anchor and — a gap
  // costing no malformed row — no disclosure either. Without a durable marker
  // the next probe reads a contiguous anchored prefix and calls it clean, and
  // the rows the repair deleted are never asked for again.
  it('still reports corrupt on the next probe, with the deleted suffix unrebuilt', async () => {
    const journal = await open()
    for (let ordinal = 0; ordinal < 5; ordinal += 1) {
      await journal.appendItem(item(ordinal), body(`m${ordinal}`), { fence: 1 })
    }
    await journal.close()
    await withJournalDatabase((db) => {
      db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(4)
    })

    const repaired = await open()
    await repaired.close()
    expect(loadJournal(root, IDENTITY.sessionId)).toMatchObject({ corrupt: true })

    // Same policy the emptied-epoch repair takes: a session that writes into the
    // epoch owns it, and a later import must not replace rows the user has seen.
    const writable = await open()
    await writable.appendItem(item(9), body('typed after the repair'), { fence: 1 })
    await writable.close()
    expect(loadJournal(root, IDENTITY.sessionId)).toMatchObject({ corrupt: false })
  })

  // The disclosure is the repair talking about itself, not the session writing:
  // counting it as content would retire the marker the instant it was raised.
  it('is not settled by the repair disclosure it appends for a malformed row', async () => {
    const journal = await open()
    for (let ordinal = 0; ordinal < 3; ordinal += 1) {
      await journal.appendItem(item(ordinal), body(`m${ordinal}`), { fence: 1 })
    }
    await journal.close()
    await withJournalDatabase((db) => {
      db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = ?').run('}{', 3)
    })

    const repaired = await open()
    expect(repaired.repair.malformedRows).toBe(1)
    await repaired.close()
    expect(loadJournal(root, IDENTITY.sessionId)).toMatchObject({ corrupt: true })
  })
})

describe('a missing epoch row', () => {
  // Sequence 1 is the anchor for the whole epoch. Validating from the first row
  // that HAPPENS to remain declares the leftovers contiguous, and replay then
  // renders a repaired journal as a clean timeline.
  it('rejects the whole surviving range rather than declaring it contiguous', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('anchor'), { fence: 1 })
    await journal.appendSubmission({
      clientMessageId: 'client-message-1',
      payloadFingerprint: 'fingerprint-1',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'the user typed this' }]
      },
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'client-message-1',
      state: 'accepted',
      providerIdentity: item(1),
      fence: 1
    })
    await journal.close()
    await withJournalDatabase((db) => {
      db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(1)
    })

    const reopened = await open()
    expect(reopened.repair).toEqual({ malformedRows: 0 })
    expect(reopened.snapshot().items).toEqual([])

    // The epoch cannot be left row-less. An ordinary append would then take
    // sequence 1, and replay would call that non-epoch row a clean timeline.
    expect(await liveSequences()).toEqual([1])
    const anchor = await firstLiveRow()
    expect(anchor).toMatchObject({ kind: 'epoch', reason: 'unreconcilable_prefix' })
  })

  // The repair epoch is a placeholder for history it could not rebuild. Left
  // clean it would end automatic recovery: the provider transcript is never
  // consulted again and the dropped rows never come back.
  it('keeps asking for provider history until the epoch has content of its own', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('anchor'), { fence: 1 })
    await journal.close()
    await withJournalDatabase((db) => {
      db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(1)
    })

    const repaired = await open()
    await repaired.close()
    expect(loadJournal(root, IDENTITY.sessionId)).toMatchObject({ corrupt: true })

    // A session that writes into the epoch owns it: its own rows are not a
    // repair placeholder, and a later import must not replace them.
    const writable = await open()
    await writable.appendItem(item(1), body('typed after the repair'), { fence: 1 })
    await writable.close()
    expect(loadJournal(root, IDENTITY.sessionId)).toMatchObject({ corrupt: false })
  })
})
