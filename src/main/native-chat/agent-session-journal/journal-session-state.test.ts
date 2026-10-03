// Each chat's stored status: written in the same transaction as every journal write, equal to what a
// fresh replay derives, for every chat state; a failed write leaves the fold equal to the disk.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import { activeStructuredAgentSessionTurnIdBySequence } from '../../../shared/structured-agent-session-live-turn'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { journalPragmaNumber } from './journal-database'
import { journalDatabasePath } from './journal-host-database'
import Database from '../../sqlite/sync-database'
import {
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  loadTestJournal,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from './journal-host-database-test-support'
import * as JournalFoldUndo from './journal-fold-undo'
import * as JournalOpen from './journal-open'
import { renderJournalState } from './journal-reducer'
import { deleteJournalRepairedSuffix } from './journal-repair-marker'
import {
  deriveJournalSessionStatus,
  isUnsettledJournalSessionStatus,
  readUnsettledJournalSessionIds,
  writeJournalSessionStatusFromDisk,
  type JournalSessionStatus
} from './journal-session-state'
import {
  CORPUS_FENCE,
  CORPUS_UNSETTLED,
  JOURNAL_SESSION_STATE_CASES,
  JOURNAL_SESSION_STATE_CORPUS,
  type JournalSessionStateCase
} from './journal-session-state-test-corpus'
import type { AgentSessionJournal } from './journal-store'

vi.mock('./journal-open', async (importOriginal) => {
  const actual = await importOriginal<typeof JournalOpen>()
  return { ...actual, replayJournal: vi.fn(actual.replayJournal) }
})
vi.mock('./journal-fold-undo', async (importOriginal) => {
  const actual = await importOriginal<typeof JournalFoldUndo>()
  return { ...actual, beginJournalFoldUndo: vi.fn(actual.beginJournalFoldUndo) }
})

const journals = createTrackedJournalOpener()
let root: string
let clock = 1_000

function identity(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'ws-1',
    hostId: 'local',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: `thread-${sessionId}` }
  }
}

function open(sessionId: string): Promise<AgentSessionJournal> {
  return journals.open({
    identity: identity(sessionId),
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => `epoch-${sessionId}-${clock}`,
    // As production passes the record's fence.
    currentFence: () => CORPUS_FENCE
  })
}

function db() {
  return openTestJournalHostDatabase(root).db
}

/** What a fresh open of the chat would derive, read back from disk. */
function freshDerivation(sessionId: string): JournalSessionStatus {
  const loaded = loadTestJournal(root, sessionId)
  if (!loaded) {
    throw new Error(`no journal for ${sessionId}`)
  }
  return deriveJournalSessionStatus(loaded.state, {
    settlesRosters: !loaded.corrupt,
    currentFence: CORPUS_FENCE
  })
}

const stored = (sessionId: string) => readTestJournalSessionStatus(root, sessionId)

async function write(name: JournalSessionStateCase): Promise<AgentSessionJournal> {
  const journal = await open(name)
  await JOURNAL_SESSION_STATE_CORPUS[name](journal)
  return journal
}

function note(journal: AgentSessionJournal, id: string) {
  return journal.appendItem(
    { provider: 'orca', clientMessageId: id },
    { kind: 'status', text: id },
    { fence: 3, turnScope: { kind: 'thread' } }
  )
}

function reply(journal: AgentSessionJournal, text: string) {
  return journal.appendItem(
    { provider: 'orca', clientMessageId: 'reply' },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    { fence: 3, turnScope: { kind: 'thread' } }
  )
}

/** Fails the next COMMIT the connection runs, once. */
function failNextCommit(): void {
  const connection = db()
  const exec = connection.exec.bind(connection)
  let failing = true
  vi.spyOn(connection, 'exec').mockImplementation((sql: string) => {
    if (failing && sql === 'COMMIT') {
      failing = false
      throw new Error('COMMIT failed: disk I/O error')
    }
    return exec(sql)
  })
}

function refuseStatusWrites(): void {
  db().exec(`CREATE TEMP TRIGGER fail_status_write BEFORE UPDATE ON main.journal_session_state
    BEGIN SELECT RAISE(ABORT, 'status write refused'); END`)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-session-state-'))
  clock = 1_000
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('the stored status follows every write (T3)', () => {
  it.each(JOURNAL_SESSION_STATE_CASES)('%s', async (name) => {
    const journal = await open(name)
    const mismatches: string[] = []
    // Told after each commit, which carried the row and its status together.
    journal.observeCommits(() => {
      const expected = freshDerivation(name)
      try {
        expect(stored(name)).toEqual(expected)
      } catch {
        mismatches.push(`seq ${journal.cursor().sequence}`)
      }
    })
    await JOURNAL_SESSION_STATE_CORPUS[name](journal)
    expect(mismatches).toEqual([])
    expect(stored(name)).toEqual(freshDerivation(name))
    expect(isUnsettledJournalSessionStatus(stored(name)!)).toBe(CORPUS_UNSETTLED[name])
    expect(readUnsettledJournalSessionIds(db()).includes(name)).toBe(CORPUS_UNSETTLED[name])
    // The active turn the facts pass finds is the by-sequence reader's.
    expect(stored(name)?.activeTurnId).toBe(
      activeStructuredAgentSessionTurnIdBySequence(
        loadTestJournal(root, name)!.state.items.values()
      )
    )
  })
})

describe('observers hear of a write only once it is committed (T13)', () => {
  it('tells observers after COMMIT, when another connection already reads the row and its status', async () => {
    const journal = await open('committed')
    const seen: { inTransaction: boolean; rows: unknown; status: unknown }[] = []
    journal.observeCommits(() => {
      const other = new Database(journalDatabasePath(root), { readonly: true })
      try {
        seen.push({
          inTransaction: db().isTransaction,
          rows: other
            .prepare('SELECT COUNT(*) AS n FROM journal_rows WHERE session_id = ?')
            .get('committed'),
          status: other
            .prepare('SELECT lifecycle FROM journal_session_state WHERE session_id = ?')
            .get('committed')
        })
      } finally {
        other.close()
      }
    })

    await note(journal, 'note-1')

    expect(seen).toEqual([{ inTransaction: false, rows: { n: 2 }, status: { lifecycle: 'idle' } }])
  })
})

describe('a chat that opened corrupt stores what a fresh replay derives (T3)', () => {
  const name = 'working subagent roster'

  async function openCorrupt(): Promise<AgentSessionJournal> {
    const journal = await write(name)
    const tip = journal.cursor()
    await journal.close()
    // A bad write past the tip: the next open drops it and owes a rebuild from provider history.
    insertTestJournalRowJson(db(), name, tip.sequence + 1, '{"not a row"')
    const reopened = await open(name)
    expect(reopened.needsRebuild).toBe(true)
    // The repair wrote the status; rosters wait for the rebuild, as the settle does.
    expect(stored(name)).toEqual(freshDerivation(name))
    expect(stored(name)).toMatchObject({ liveChildWork: false })
    return reopened
  }

  it('shows the roster again once the chat writes past the repair', async () => {
    const journal = await openCorrupt()
    await note(journal, 'note-1')
    expect(journal.needsRebuild).toBe(false)
    expect(stored(name)).toEqual(freshDerivation(name))
    expect(stored(name)).toMatchObject({ liveChildWork: true })
  })

  it('shows the roster again once provider history rebuilds the chat', async () => {
    const journal = await openCorrupt()
    await journal.replaceEpochItems('legacy_import', 3, [
      {
        identity: { provider: 'orca', clientMessageId: 'roster-1' },
        body: {
          kind: 'message',
          role: 'system',
          blocks: [
            {
              type: 'subagent-group',
              groupId: 'group-1',
              agents: [{ id: 'child-1', label: 'reads', state: 'working', startedAt: 10 }]
            }
          ]
        }
      }
    ])
    expect(journal.needsRebuild).toBe(false)
    expect(stored(name)).toEqual(freshDerivation(name))
    expect(stored(name)).toMatchObject({ liveChildWork: true })
  })
})

describe('a repair writes the status of what it leaves (T10)', () => {
  it('drops the rejected suffix and the status that described it, in one transaction', async () => {
    const journal = await write('running tool')
    const tip = journal.cursor()
    await journal.close()
    expect(stored('running tool')).toMatchObject({ lifecycle: 'running' })

    deleteJournalRepairedSuffix({
      database: openTestJournalHostDatabase(root),
      sessionId: 'running tool',
      epoch: tip.epoch,
      fromSeq: tip.sequence,
      contentFrom: tip.sequence,
      now: clock + 1,
      writeStatus: (database) => writeJournalSessionStatusFromDisk(database, 'running tool')
    })

    expect(stored('running tool')).toEqual(freshDerivation('running tool'))
    expect(stored('running tool')).toMatchObject({ lifecycle: 'idle' })
  })
})

describe('a failed write leaves the fold equal to the disk (T1)', () => {
  it('puts back what a failed COMMIT folded, stores nothing, and the next append takes the sequence', async () => {
    const journal = await write('settled')
    const tip = journal.cursor()
    const before = stored('settled')
    failNextCommit()
    vi.mocked(JournalOpen.replayJournal).mockClear()

    await expect(reply(journal, 'lost')).rejects.toThrow('COMMIT failed')

    // Undone in memory: the chat is not read from disk again.
    expect(JournalOpen.replayJournal).not.toHaveBeenCalled()
    expect(journal.cursor()).toEqual(tip)
    expect(journal.snapshot()).toEqual(renderJournalState(loadTestJournal(root, 'settled')!.state))
    expect(stored('settled')).toEqual(before)
    await expect(reply(journal, 'kept')).resolves.toMatchObject({
      cursor: { sequence: tip.sequence + 1 }
    })
    // Not the projection of the reply that rolled back, which held the same sequence.
    expect(stored('settled')).toEqual(freshDerivation('settled'))
    expect(stored('settled')?.summary.lastAssistantMessage).toBe('kept')
  })

  it('fails the append when its status write fails: the row and its status land together or not at all', async () => {
    const journal = await write('settled')
    const tip = journal.cursor()
    refuseStatusWrites()

    await expect(note(journal, 'refused')).rejects.toThrow('status write refused')

    expect(loadTestJournal(root, 'settled')?.state.lastSequence).toBe(tip.sequence)
    expect(journal.cursor()).toEqual(tip)
    expect(journal.snapshot()).toEqual(renderJournalState(loadTestJournal(root, 'settled')!.state))
    db().exec('DROP TRIGGER fail_status_write')
    await expect(note(journal, 'kept')).resolves.toMatchObject({
      cursor: { sequence: tip.sequence + 1 }
    })
  })

  it('never shows a held submission the change that rolled back', async () => {
    const journal = await open('held')
    await journal.appendSubmission({
      clientMessageId: 'send-1',
      payloadFingerprint: 'fp',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      fence: 3
    })
    const held = journal.submission('send-1')!
    expect(held.dispatchState).toBe('pending')
    failNextCommit()

    await expect(
      journal.resolveDispatch({
        clientMessageId: 'send-1',
        state: 'accepted',
        providerIdentity: {
          provider: 'codex',
          threadId: 'thread-held',
          turnId: 'turn-1',
          ordinal: 1
        },
        fence: 3
      })
    ).rejects.toThrow('COMMIT failed')

    expect(held.dispatchState).toBe('pending')
    expect(journal.submission('send-1')).toMatchObject({ dispatchState: 'pending' })
  })

  it('re-reads before next use a fold whose undo failed, and keeps the chat open', async () => {
    const journal = await write('settled')
    const tip = journal.cursor()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(JournalFoldUndo.beginJournalFoldUndo).mockImplementationOnce(() => ({
      commit: () => undefined,
      rollback: () => {
        throw new Error('undo failed')
      }
    }))
    failNextCommit()

    await expect(note(journal, 'lost')).rejects.toThrow('COMMIT failed')

    // The next read re-reads the disk instead of serving the fold that held the lost row.
    expect(journal.cursor()).toEqual(tip)
    expect(journal.snapshot()).toEqual(renderJournalState(loadTestJournal(root, 'settled')!.state))
    await expect(note(journal, 'kept')).resolves.toMatchObject({
      cursor: { sequence: tip.sequence + 1 }
    })
  })
})

describe('a stale fold is never read back inside a transaction (R2W-3)', () => {
  it('keeps a stale fold on the committed epoch through a roll whose COMMIT fails', async () => {
    const journal = await write('settled')
    const committedEpoch = journal.epoch
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // An append fails and its undo fails too: the fold is stale.
    vi.mocked(JournalFoldUndo.beginJournalFoldUndo).mockImplementationOnce(() => ({
      commit: () => undefined,
      rollback: () => {
        throw new Error('undo failed')
      }
    }))
    failNextCommit()
    await expect(note(journal, 'lost')).rejects.toThrow('COMMIT failed')
    // The next write is a roll, and its COMMIT fails too.
    vi.restoreAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    failNextCommit()

    await expect(journal.rollEpoch('handle_forked', 3)).rejects.toThrow('COMMIT failed')

    expect(journal.epoch).toBe(committedEpoch)
    expect(loadTestJournal(root, 'settled')?.state.epoch).toBe(committedEpoch)
    // An acknowledged append lands where every replay reads it.
    await note(journal, 'after-roll')
    expect(
      [...loadTestJournal(root, 'settled')!.state.items.keys()].some((id) =>
        id.includes('after-roll')
      )
    ).toBe(true)
  })
})

describe('epoch writes carry the status (T10)', () => {
  it('writes it for a new epoch, a roll and a replacement, in their transactions', async () => {
    const journal = await open('epochs')
    expect(stored('epochs')).toMatchObject({ lifecycle: 'idle', summary: { status: null } })
    await JOURNAL_SESSION_STATE_CORPUS['running tool'](journal)
    expect(stored('epochs')).toMatchObject({ lifecycle: 'running' })

    await journal.rollEpoch('unreconcilable_prefix', 3)
    expect(stored('epochs')).toEqual(freshDerivation('epochs'))
    expect(stored('epochs')).toMatchObject({ lifecycle: 'idle' })

    await journal.replaceEpochItems('legacy_import', 3, [
      {
        identity: { provider: 'orca', clientMessageId: 'rebuilt-1' },
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'rebuilt' }] }
      }
    ])
    expect(stored('epochs')).toEqual(freshDerivation('epochs'))
  })

  it('fails a roll whose status write fails, leaving the epoch where it was', async () => {
    const journal = await write('settled')
    const epoch = journal.epoch
    refuseStatusWrites()

    await expect(journal.rollEpoch('handle_forked', 3)).rejects.toThrow('status write refused')

    expect(journal.epoch).toBe(epoch)
    expect(loadTestJournal(root, 'settled')?.state.epoch).toBe(epoch)
  })

  it('arrives with schema version 5', async () => {
    await write('settled')
    expect(JOURNAL_DB_SCHEMA_VERSION).toBe(5)
    expect(journalPragmaNumber(db(), 'user_version')).toBe(5)
  })
})

describe('a stored summary is fence-independent once settled (T15a, regression guard)', () => {
  it.each(JOURNAL_SESSION_STATE_CASES)('%s', async (name) => {
    await write(name)
    const derived = freshDerivation(name)
    if (isUnsettledJournalSessionStatus(derived)) {
      return
    }
    const snapshot = renderJournalState(loadTestJournal(root, name)!.state)
    for (const fence of [undefined, 0, 3, 4, 100]) {
      expect(
        projectStructuredAgentSessionStatusState(snapshot.items, snapshot.submissions, fence)
          .summary
      ).toEqual(derived.summary)
    }
  })
})
