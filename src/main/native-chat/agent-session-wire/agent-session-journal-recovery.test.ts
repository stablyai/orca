import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// Recovery drives the real journal loader against real on-disk damage: a hole
// punched in the row sequence, and a row stamped with a schema this host cannot
// read — on both version axes, because only one of them is detectable before a
// read.

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { JOURNAL_DB_SCHEMA_VERSION } from '../agent-session-journal/journal-database-schema'
import { journalDatabasePath } from '../agent-session-journal/journal-host-database'
import { replayJournal } from '../agent-session-journal/journal-open'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  loadTestJournal,
  readTestJournalRows,
  deleteTestJournalRow,
  insertTestJournalRowJson,
  updateTestJournalRowJson
} from '../agent-session-journal/journal-host-database-test-support'
import type Database from '../../sqlite/sync-database'
import {
  openAgentSessionJournalWithRecovery,
  providerHistoryId
} from './agent-session-journal-recovery'
import { JOURNAL_NEWER_SCHEMA_MESSAGE } from '../agent-session-journal/journal-open-failure'
import { performSend, type AgentSessionTurnContext } from './structured-agent-session-turns'

// The store's replay goes through the mock: it is the only read of the journal an open makes.
vi.mock('../agent-session-journal/journal-open', async (importOriginal) => {
  const actual = await importOriginal<{ replayJournal: typeof replayJournal }>()
  return { ...actual, replayJournal: vi.fn(actual.replayJournal) }
})

const CODEX_SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: CODEX_SESSION,
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: CODEX_SESSION }
}

const CODEX_LINES = [
  {
    type: 'session_meta',
    timestamp: '2026-08-05T10:00:00.000Z',
    payload: {
      id: CODEX_SESSION,
      session_id: CODEX_SESSION,
      cwd: '/Users/dev/project',
      originator: 'codex_cli_rs',
      cli_version: '0.146.1'
    }
  },
  {
    type: 'event_msg',
    timestamp: '2026-08-05T10:00:02.000Z',
    payload: { type: 'user_message', message: 'add a retry', kind: 'plain' }
  },
  {
    type: 'event_msg',
    timestamp: '2026-08-05T10:00:05.000Z',
    payload: { type: 'agent_message', message: 'On it.' }
  }
]

let root: string
let journalDir: string
let historyFilePath: string
const journals = createTrackedJournalOpener()

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: CODEX_SESSION, turnId: 'turn-1', ordinal }
}

/** Fills a journal with `count` items and hands back its epoch. */
async function seedJournal(count: number): Promise<string> {
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: journalDir })
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    await journal.appendItem(
      item(ordinal),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `item-${ordinal}` }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  const epoch = journal.epoch
  await journal.close()
  return epoch
}

/** A journal whose epoch row is gone: every surviving row is unanchored, so a
 *  repair has to set aside the whole range. */
async function seedRepairableSession(): Promise<void> {
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: journalDir })
  await journal.appendSubmission({
    clientMessageId: 'client-message-1',
    payloadFingerprint: 'fingerprint-1',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'add a retry' }] },
    fence: 1
  })
  await journal.resolveDispatch({
    clientMessageId: 'client-message-1',
    state: 'accepted',
    providerIdentity: item(1),
    fence: 1
  })
  await journal.close()
  await deleteRow(1)
}

async function withJournalDatabase(
  directory: string,
  run: (db: Database.Database) => void
): Promise<void> {
  run(openTestJournalHostDatabase(directory).db)
}

async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

/** The same logical hole `findSequenceGap` detects at replay. */
async function deleteRow(seq: number): Promise<void> {
  await withJournalDatabase(journalDir, (db) => {
    deleteTestJournalRow(db, CODEX_SESSION, seq)
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wire-recovery-'))
  journalDir = join(root, 'journal')
  historyFilePath = join(root, 'rollout.jsonl')
  await writeFile(
    historyFilePath,
    `${CODEX_LINES.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf-8'
  )
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('providerHistoryId', () => {
  it('uses the provider handle, never the Orca session id', () => {
    expect(providerHistoryId({ kind: 'codex', threadId: 'thread-9' })).toBe('thread-9')
    expect(providerHistoryId({ kind: 'claude', sessionId: 'sess-9', leafUuid: null })).toBe(
      'sess-9'
    )
  })
})

describe('openAgentSessionJournalWithRecovery', () => {
  it('opens a healthy journal untouched', async () => {
    await seedJournal(2)
    const opened = journals.track(
      await openAgentSessionJournalWithRecovery({
        identity: IDENTITY,
        database: openTestJournalHostDatabase(journalDir),
        fence: 1,
        historyFilePath
      }).then((result) => result.journal)
    )
    expect(opened.snapshot().items).toHaveLength(2)
  })

  it("reads the journal once: the store's replay is the open", async () => {
    await seedJournal(2)
    vi.mocked(replayJournal).mockClear()
    const opened = journals.track(
      await openAgentSessionJournalWithRecovery({
        identity: IDENTITY,
        database: openTestJournalHostDatabase(journalDir),
        fence: 1,
        historyFilePath
      }).then((result) => result.journal)
    )
    expect(opened.snapshot().items).toHaveLength(2)
    expect(replayJournal).toHaveBeenCalledOnce()
  })

  it('rebuilds a holed journal in place on a fresh epoch', async () => {
    await seedJournal(3)
    await deleteRow(3)

    const opened = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      database: openTestJournalHostDatabase(journalDir),
      fence: 1,
      historyFilePath
    })
    journals.track(opened.journal)
    expect(opened.recovery).toMatchObject({ trigger: 'journal_corrupt', reset: 'epoch_changed' })
    expect(opened.recovery?.imported).toBeGreaterThan(0)
    expect(opened.journal.isReadOnly).toBe(false)
    // The rebuilt timeline is the only content of its epoch — nothing from the
    // damaged prefix survives into it.
    const texts = opened.journal.snapshot().items.map((entry) => JSON.stringify(entry.body))
    expect(texts.some((text) => text.includes('item-1'))).toBe(false)
    expect(texts.some((text) => text.includes('add a retry'))).toBe(true)
  })

  // A newer build's row is never rewritten under it, and there is no sibling to write instead:
  // the chat reads what it can and refuses writes.
  it('opens a future row-body version read-only and leaves it exactly as found', async () => {
    const epoch = await seedJournal(1)
    await withJournalDatabase(journalDir, (db) => {
      insertTestJournalRowJson(
        db,
        CODEX_SESSION,
        3,
        JSON.stringify({ v: 99, seq: 3, epoch, kind: 'item', fence: 1, ts: 1 })
      )
    })

    const opened = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      database: openTestJournalHostDatabase(journalDir),
      fence: 1,
      historyFilePath
    })
    journals.track(opened.journal)

    expect(opened.recovery).toBeNull()
    expect(opened.journal.isReadOnly).toBe(true)
    // A send says to update, as a database a newer Orca wrote does.
    const sent = await performSend(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a refused append returns before anything but the journal and fence is read.
      { sessionId: CODEX_SESSION, journal: opened.journal, fence: 1 } as AgentSessionTurnContext,
      {
        clientMessageId: 'client-after-downgrade',
        payloadFingerprint: 'fp',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
      }
    )
    expect(sent).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalWrittenByNewerOrca' },
        message: JOURNAL_NEWER_SCHEMA_MESSAGE
      }
    })
    await withJournalDatabase(journalDir, (db) => {
      const rows = readTestJournalRows(db, CODEX_SESSION, epoch)
      expect(rows.some((entry) => entry.rowJson.includes('"v":99'))).toBe(true)
      expect(rows).toHaveLength(3)
    })
  })

  // A downgrade: the database a newer Orca stamped opens read-only. The chat shows its history, a
  // send says to update, and the file is left byte-identical.
  it('shows a chat from a database a newer Orca stamped, and a send says to update', async () => {
    await seedJournal(2)
    await withJournalDatabase(journalDir, (db) => {
      db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`)
    })
    closeTestJournalHostDatabases()
    const path = journalDatabasePath(journalDir)
    const before = await digest(path)

    const opened = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      database: openTestJournalHostDatabase(journalDir),
      fence: 1,
      historyFilePath
    })
    journals.track(opened.journal)

    expect(opened.recovery).toBeNull()
    expect(opened.journal.isReadOnly).toBe(true)
    const texts = opened.journal.snapshot().items.map((entry) => JSON.stringify(entry.body))
    expect(texts.filter((text) => /item-[12]/.test(text))).toHaveLength(2)
    const sent = await performSend(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a refused append returns before anything but the journal and fence is read.
      { sessionId: CODEX_SESSION, journal: opened.journal, fence: 1 } as AgentSessionTurnContext,
      {
        clientMessageId: 'client-after-downgrade',
        payloadFingerprint: 'fp',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
      }
    )
    expect(sent).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalWrittenByNewerOrca' },
        message: JOURNAL_NEWER_SCHEMA_MESSAGE
      }
    })
    await journals.closeAll()
    expect(await digest(path)).toBe(before)
  })

  // T-logical-per-chat: one file holds every chat, and damage one chat's replay finds is still
  // that chat's alone. Only it rebuilds; a neighbour's rows and epoch are not touched.
  it('rebuilds only the damaged chat and leaves another chat in the same file untouched', async () => {
    const neighbour: AgentSessionJournalIdentity = {
      ...IDENTITY,
      sessionId: 'neighbour-session',
      providerHandle: { kind: 'codex', threadId: 'neighbour-thread' }
    }
    const other = await journals.open({ identity: neighbour, stateDirectory: journalDir })
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      await other.appendItem(
        item(ordinal),
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `n-${ordinal}` }] },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    const neighbourEpoch = other.epoch
    await other.close()
    const database = openTestJournalHostDatabase(journalDir)
    const neighbourBefore = readTestJournalRows(database.db, neighbour.sessionId, neighbourEpoch)
    await seedJournal(3)
    await withJournalDatabase(journalDir, (db) => {
      updateTestJournalRowJson(db, CODEX_SESSION, 3, '}{')
    })

    const opened = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      database,
      fence: 1,
      historyFilePath
    })
    journals.track(opened.journal)

    expect(opened.recovery).toMatchObject({ trigger: 'journal_corrupt', reset: 'epoch_changed' })
    expect(opened.recovery?.imported).toBeGreaterThan(0)
    const reopened = await journals.open({ identity: neighbour, stateDirectory: journalDir })
    expect(reopened.epoch).toBe(neighbourEpoch)
    expect(readTestJournalRows(database.db, neighbour.sessionId, neighbourEpoch)).toEqual(
      neighbourBefore
    )
  })

  // The rehydrate deletes every live row to publish its replacement epoch, so
  // everything replay rejected is gone for good by the time the import runs.
  // Orca minted the submission, receipt and lifecycle identities; no provider
  // transcript can hand them back.
  it('rebuilds from provider history when the epoch row itself is gone', async () => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: journalDir })
    await journal.appendSubmission({
      clientMessageId: 'client-message-1',
      payloadFingerprint: 'fingerprint-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'add a retry' }] },
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'client-message-1',
      state: 'accepted',
      providerIdentity: item(1),
      fence: 1
    })
    await journal.appendLifecycleBatch({
      settlementId: 'settlement-1',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: { provider: 'orca', clientMessageId: 'approval-1' },
          body: { kind: 'status', text: 'approved' },
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ]
    })
    await journal.close()
    // Sequence 1 is the epoch row: everything behind it is valid but unanchored.
    await deleteRow(1)

    const opened = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      database: openTestJournalHostDatabase(journalDir),
      fence: 1,
      historyFilePath
    })
    journals.track(opened.journal)
    expect(opened.recovery).toMatchObject({ trigger: 'journal_corrupt' })
    expect(opened.recovery?.imported).toBeGreaterThan(0)
    expect(JSON.stringify(opened.journal.snapshot().items.map((entry) => entry.body))).toContain(
      'add a retry'
    )
  })

  it('still opens the session when provider history cannot be read', async () => {
    await seedJournal(3)
    await deleteRow(3)

    const opened = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      database: openTestJournalHostDatabase(journalDir),
      fence: 1,
      historyFilePath: join(root, 'missing.jsonl')
    })
    journals.track(opened.journal)
    expect(opened.recovery).toMatchObject({ trigger: 'journal_corrupt', imported: 0 })
    expect(opened.recovery?.error).toBeTruthy()
    // A missing provider transcript must not clear the intact journal prefix.
    expect(opened.journal.snapshot().items.map((entry) => entry.body.kind)).toEqual(['message'])
  })

  // A repair that KEEPS a prefix has no emptied epoch to anchor, so nothing
  // about the surviving rows records that the deleted suffix was never rebuilt.
  // Unmarked, the next probe reads a contiguous anchored prefix, calls it clean,
  // and the dropped stretch of timeline is gone for good.
  it('keeps a partially repaired journal corrupt until provider history replaces it', async () => {
    await seedJournal(3)
    await deleteRow(3)
    const empty = join(root, 'empty.jsonl')
    await writeFile(empty, '', 'utf-8')

    const first = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      database: openTestJournalHostDatabase(journalDir),
      fence: 1,
      historyFilePath: empty
    })
    journals.track(first.journal)
    expect(first.recovery).toMatchObject({ trigger: 'journal_corrupt', imported: 0 })
    expect(first.recovery?.error).toBeTruthy()
    // Only the unanchored suffix went; the prefix the repair kept is still live.
    expect(first.journal.snapshot().items.map((entry) => entry.body.kind)).toEqual(['message'])
    await first.journal.close()

    // The deletion is durable, so the demand for a rebuild has to be too.
    expect(await loadTestJournal(journalDir, CODEX_SESSION)).toMatchObject({ corrupt: true })

    // A readable transcript rebuilds the epoch, and THAT is what retires it.
    const retried = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      database: openTestJournalHostDatabase(journalDir),
      fence: 1,
      historyFilePath
    })
    journals.track(retried.journal)
    expect(retried.recovery?.imported).toBeGreaterThan(0)
    await retried.journal.close()
    expect(await loadTestJournal(journalDir, CODEX_SESSION)).toMatchObject({ corrupt: false })
  })

  // The reproduced path. Deleting sequence 1 leaves every surviving row
  // unanchored, so the repair drops ALL of them — and provider history is not
  // there to publish a replacement. A journal in that state used to reopen as
  // clean: an append took sequence 1 as an ordinary row, replay accepted it,
  // and recovery never asked the provider for the timeline again.
  it('does not normalize an epoch a repair emptied while provider history was unavailable', async () => {
    await seedRepairableSession()
    const missing = join(root, 'missing.jsonl')

    const first = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      database: openTestJournalHostDatabase(journalDir),
      fence: 1,
      historyFilePath: missing
    })
    journals.track(first.journal)
    expect(first.recovery?.error).toBeTruthy()
    expect(first.recovery?.imported).toBe(0)
    await first.journal.close()

    // Reopen: the epoch still holds nothing but the repair, so recovery runs again.
    expect(await loadTestJournal(journalDir, CODEX_SESSION)).toMatchObject({ corrupt: true })
    const reopened = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      database: openTestJournalHostDatabase(journalDir),
      fence: 1,
      historyFilePath: missing
    })
    journals.track(reopened.journal)
    expect(reopened.recovery).toMatchObject({ trigger: 'journal_corrupt', imported: 0 })
    // Nothing but the anchor: the repair rebuilt no history of its own.
    expect(reopened.journal.snapshot().items).toEqual([])

    // The append lands ABOVE the epoch anchor, never on top of it.
    await reopened.journal.appendItem(
      item(2),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'typed later' }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const epoch = reopened.journal.epoch
    await reopened.journal.close()
    await withJournalDatabase(journalDir, (db) => {
      const rows = readTestJournalRows(db, CODEX_SESSION, epoch)
      expect(JSON.parse(rows[0]?.rowJson ?? '{}')).toMatchObject({ kind: 'epoch', seq: 1 })
    })
  })

  // An empty transcript is a plausible transient provider state, and it used to
  // end recovery for good: the import published an empty replacement epoch that
  // deleted the repair's anchor, the next probe called that clean, and the user's
  // timeline was never rebuilt.
  it('does not retire the repair marker when provider history exists but holds no messages', async () => {
    await seedRepairableSession()
    const empty = join(root, 'empty.jsonl')
    await writeFile(empty, '', 'utf-8')

    const first = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      database: openTestJournalHostDatabase(journalDir),
      fence: 1,
      historyFilePath: empty
    })
    journals.track(first.journal)
    expect(first.recovery).toMatchObject({ trigger: 'journal_corrupt', imported: 0 })
    expect(first.recovery?.error).toBeTruthy()
    // The anchor the repair published is still the epoch; the empty import did
    // not replace it with a clean one.
    expect(first.journal.snapshot().items).toEqual([])
    const epoch = first.journal.epoch
    await first.journal.close()
    await withJournalDatabase(journalDir, (db) => {
      const rows = readTestJournalRows(db, CODEX_SESSION, epoch)
      expect(JSON.parse(rows[0]?.rowJson ?? '{}')).toMatchObject({
        kind: 'epoch',
        seq: 1,
        reason: 'unreconcilable_prefix'
      })
    })

    // The session still reports corrupt, so the next attach retries.
    expect(await loadTestJournal(journalDir, CODEX_SESSION)).toMatchObject({ corrupt: true })

    // And a transcript that DOES have content still rebuilds the timeline.
    const retried = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      database: openTestJournalHostDatabase(journalDir),
      fence: 1,
      historyFilePath
    })
    journals.track(retried.journal)
    expect(retried.recovery?.imported).toBeGreaterThan(0)
    expect(JSON.stringify(retried.journal.snapshot().items.map((entry) => entry.body))).toContain(
      'add a retry'
    )
  })

  it('rebuilds the emptied epoch once provider history is readable again', async () => {
    await seedRepairableSession()

    const first = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      database: openTestJournalHostDatabase(journalDir),
      fence: 1,
      historyFilePath: join(root, 'missing.jsonl')
    })
    journals.track(first.journal)
    await first.journal.close()

    const retried = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      database: openTestJournalHostDatabase(journalDir),
      fence: 1,
      historyFilePath
    })
    journals.track(retried.journal)
    expect(retried.recovery?.imported).toBeGreaterThan(0)
    expect(JSON.stringify(retried.journal.snapshot().items.map((entry) => entry.body))).toContain(
      'add a retry'
    )
  })
})
