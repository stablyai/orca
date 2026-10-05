// A newer build's row kind is never damage: like a newer row version, it fails this build's load as
// a newer Orca's chat with every row kept, so the newer build still reads the whole chat after an
// upgrade.
// A row whose stored sequence and body disagree is damage, which fails the load with every row kept.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  SAVED_BY_NEWER_ORCA
} from './journal-host-database-test-support'
import { parseJournalRow, type JournalRow } from './journal-row-schema'

const UNLOADABLE = {
  refusal: { code: 'agent_session_journal_unreadable', details: { reason: 'journalCorrupt' } }
}

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-newer-kind',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}
const SCOPE = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-newer-kind-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function itemIds(journal: { snapshot: () => { items: { itemId: string }[] } }): string[] {
  return journal.snapshot().items.map((entry) => entry.itemId)
}

/** What a newer build would write: a kind this build does not know, in the envelope every row keeps. */
function newerRow(epoch: string, seq: number, extra: Record<string, unknown> = {}) {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    kind: 'future-mark',
    epoch,
    seq,
    fence: 1,
    ts: 5_000 + seq,
    payload: { said: 'by a newer build', seq },
    ...extra
  }
}

function open() {
  return journals.open({ identity: IDENTITY, stateDirectory: root })
}

/** Closes the chat, applies `edit` to its stored rows as a newer build or a bad write would, and
 *  reopens it as a restarted host would. */
/** Rewrites rows with every journal closed, so the caller's next open replays them. */
async function rewriteClosed(edit: (put: (seq: number, json: string) => void) => void = () => {}) {
  await journals.closeAll()
  const { db } = openTestJournalHostDatabase(root)
  edit((seq, json) => {
    db.prepare('DELETE FROM journal_rows WHERE session_id = ? AND seq = ?').run(
      IDENTITY.sessionId,
      seq
    )
    insertTestJournalRowJson(db, IDENTITY.sessionId, seq, json, 5_000 + seq)
  })
  closeTestJournalHostDatabase(root)
}

async function restartAfter(edit: (put: (seq: number, json: string) => void) => void = () => {}) {
  await rewriteClosed(edit)
  return open()
}

function stored(): { seq: number; rowJson: string }[] {
  return liveTestJournalRows(openTestJournalHostDatabase(root).db, IDENTITY.sessionId).map(
    (row) => ({ seq: row.seq, rowJson: row.rowJson })
  )
}

function storedKinds(): [number, unknown][] {
  return stored().map((row) => [row.seq, JSON.parse(row.rowJson).kind])
}

/** A journal of its anchor and one item, closed: the next row lands at sequence 3. */
async function journalWithOneItem(): Promise<string> {
  const first = await open()
  await first.appendItem(item(0), { kind: 'status', text: 'before' }, SCOPE)
  return first.epoch
}

/** One valid row of every kind this build writes; a kind added to the union without one here
 *  fails to compile. */
function rowOfEveryKind(): { [Kind in JournalRow['kind']]: Extract<JournalRow, { kind: Kind }> } {
  const base = { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, epoch: 'epoch-1', fence: 1, ts: 1 }
  const providerHandle = IDENTITY.providerHandle
  return {
    epoch: { ...base, seq: 1, kind: 'epoch', reason: 'session_created', providerHandle },
    item: {
      ...base,
      seq: 2,
      kind: 'item',
      itemId: 'i',
      revision: 1,
      body: { kind: 'status', text: 'x' }
    },
    tombstone: { ...base, seq: 3, kind: 'tombstone', itemId: 'i', revision: 2 },
    submission: {
      ...base,
      seq: 4,
      kind: 'submission',
      clientMessageId: 'c',
      payloadFingerprint: 'f',
      providerHandle,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }
    },
    dispatch: {
      ...base,
      seq: 5,
      kind: 'dispatch',
      clientMessageId: 'c',
      state: 'accepted',
      providerItemId: null,
      reason: null
    },
    'lifecycle-batch': {
      ...base,
      seq: 6,
      kind: 'lifecycle-batch',
      settlementId: 's',
      mutations: [{ kind: 'tombstone', itemId: 'i', revision: 3 }]
    }
  }
}

it("reads a row of every kind this build writes, never as a newer build's kind", () => {
  for (const row of Object.values(rowOfEveryKind())) {
    expect(parseJournalRow(JSON.stringify(row))).toEqual({ ok: true, row })
  }
})

describe('parsing a row of a kind this build does not know', () => {
  it('reads one in the envelope every row keeps as unreadable', () => {
    expect(parseJournalRow(JSON.stringify(newerRow('epoch-1', 7)))).toEqual({
      ok: false,
      unreadable: true
    })
  })

  it.each([
    ['no sequence', { seq: undefined }],
    ['a sequence of 0', { seq: 0 }],
    ['a string sequence', { seq: '7' }],
    ['a fractional fence', { fence: 1.5 }],
    ['a string timestamp', { ts: '5007' }],
    ['an empty epoch', { epoch: '' }],
    ['an empty kind', { kind: '' }],
    ['a kind of only whitespace', { kind: ' \t' }],
    ['a kind that is not a string', { kind: 7 }]
  ])('reads one with %s as malformed', (_name, broken) => {
    const parsed = parseJournalRow(JSON.stringify(newerRow('epoch-1', 7, broken)))
    expect(parsed).toEqual({ ok: false, unreadable: false })
  })

  it('reads a known kind that fails its own checks as malformed', () => {
    const parsed = parseJournalRow(
      JSON.stringify({ ...newerRow('epoch-1', 7), kind: 'item', itemId: 'x', revision: 1 })
    )
    expect(parsed).toEqual({ ok: false, unreadable: false })
  })

  it('reads a future schema version as unreadable before it looks at the kind', () => {
    const parsed = parseJournalRow(
      JSON.stringify(newerRow('epoch-1', 7, { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION + 1 }))
    )
    expect(parsed).toEqual({ ok: false, unreadable: true })
  })
})

describe("a journal holding a newer build's row kind", () => {
  it("fails the load as a newer Orca's chat, keeps every row, and reads whole once the kind is known", async () => {
    const first = await open()
    for (const ordinal of [0, 1, 2, 3]) {
      await first.appendItem(item(ordinal), { kind: 'status', text: `item ${ordinal}` }, SCOPE)
    }
    const epoch = first.epoch
    await journals.closeAll()
    const known = stored().find((row) => row.seq === 3)?.rowJson ?? ''
    const newer = JSON.stringify(newerRow(epoch, 3))

    await rewriteClosed((put) => put(3, newer))
    const refused = stored()
    await expect(open()).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
    await expect(open()).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
    expect(stored()).toEqual(refused)
    expect(stored().find((row) => row.seq === 3)?.rowJson).toBe(newer)

    // Stand-in for the newer build after an upgrade: the same place holds a kind it reads.
    const upgraded = await restartAfter((put) => put(3, known))
    expect(itemIds(upgraded)).toHaveLength(4)
    await upgraded.appendItem(item(4), { kind: 'status', text: 'after' }, SCOPE)
    expect(upgraded.cursor().sequence).toBe(6)
  })

  it("fails the load as a newer Orca's chat with nothing deleted when the row names another sequence than its key", async () => {
    const epoch = await journalWithOneItem()
    await rewriteClosed((put) => put(3, JSON.stringify(newerRow(epoch, 9))))
    await expect(open()).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
    expect(storedKinds()).toEqual([
      [1, 'epoch'],
      [2, 'item'],
      [3, 'future-mark']
    ])
  })

  it('reads a newer kind whose envelope is broken as damage, and keeps it', async () => {
    const epoch = await journalWithOneItem()
    await expect(
      restartAfter((put) => put(3, JSON.stringify(newerRow(epoch, 3, { fence: 'one' }))))
    ).rejects.toMatchObject(UNLOADABLE)
    expect(storedKinds()).toEqual([
      [1, 'epoch'],
      [2, 'item'],
      [3, 'future-mark']
    ])
  })
})

describe('a row whose body names another sequence than its stored key', () => {
  it.each([
    ['an earlier', 2],
    ['a later', 9]
  ])('fails the load and is kept when it names %s one', async (_name, seq) => {
    const epoch = await journalWithOneItem()
    const tombstone = { ...newerRow(epoch, seq), kind: 'tombstone', itemId: 'gone', revision: 1 }
    await expect(restartAfter((put) => put(3, JSON.stringify(tombstone)))).rejects.toMatchObject(
      UNLOADABLE
    )
    expect(storedKinds()).toEqual([
      [1, 'epoch'],
      [2, 'item'],
      [3, 'tombstone']
    ])
  })
})
