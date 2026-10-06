import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { NO_LEGACY_JOURNAL_RECORDS, openJournalDatabase } from './journal-database'
import {
  classifyJournalOpenFailure,
  createJournalOpenReadRefusals,
  journalOpenReadRefusal,
  journalOpenRefusal,
  journalOpenRefusalError,
  failLoadOnUnloadableJournal
} from './journal-open-failure'
import { AgentSessionJournalError } from './journal-write-guards'
import { journalDatabasePath } from './journal-host-database'
import { replayJournal } from './journal-open'
import { createJournalReducerState } from './journal-reducer'
import { recordingStructuredAgentSessionLogger } from '../agent-session-wire/structured-agent-session-logger-test-support'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-open-failure-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** What the journal's own open, then a chat's replay, throws for the file as it stands. */
function openFailure(): unknown {
  try {
    const db = openJournalDatabase(journalDatabasePath(root), NO_LEGACY_JOURNAL_RECORDS).db
    try {
      replayJournal(db, 'session-1')
    } finally {
      db.close()
    }
  } catch (error) {
    return error
  }
  throw new Error('the journal opened')
}

/** A thrown value shaped as node:sqlite shapes one, with the result code it reports. */
function nodeSqliteError(errcode: number): Error {
  return Object.assign(new Error('sqlite'), { code: 'ERR_SQLITE_ERROR', errcode })
}

function systemError(code: string, errno: number): Error {
  return Object.assign(new Error(`${code}: open`), { code, errno })
}

describe('classifyJournalOpenFailure', () => {
  it('calls a journal that is not a database corrupt', async () => {
    await writeFile(journalDatabasePath(root), 'not a database '.repeat(64))
    const error = openFailure()
    expect(error).toMatchObject({ errcode: 26 })
    expect(classifyJournalOpenFailure(error)).toBe('journalCorrupt')
  })

  it('calls a journal whose pages are damaged corrupt', async () => {
    const path = journalDatabasePath(root)
    const opened = openJournalDatabase(path, NO_LEGACY_JOURNAL_RECORDS).db
    opened.exec('PRAGMA journal_mode = DELETE')
    opened.close()
    const bytes = await readFile(path)
    // Page 1 holds the header and schema; every table's root page follows it.
    bytes.fill(0xab, 4096)
    await writeFile(path, bytes)
    const error = openFailure()
    expect(error).toMatchObject({ errcode: 11 })
    expect(classifyJournalOpenFailure(error)).toBe('journalCorrupt')
  })

  it.each([
    ['SQLITE_CORRUPT_VTAB', 267],
    ['SQLITE_CORRUPT_SEQUENCE', 523],
    ['SQLITE_CORRUPT_INDEX', 779]
  ])('reads an extended corrupt code as corrupt: %s', (_name, errcode) => {
    expect(classifyJournalOpenFailure(nodeSqliteError(errcode))).toBe('journalCorrupt')
  })

  it('finds corruption a wrapper names as its cause', () => {
    const wrapped = new Error('opening the conversation failed', {
      cause: new Error('the journal would not open', { cause: nodeSqliteError(11) })
    })
    expect(classifyJournalOpenFailure(wrapped)).toBe('journalCorrupt')
  })

  it.each([
    ['a busy database', nodeSqliteError(5)],
    ['a locked database', nodeSqliteError(6)],
    ['a database SQLite cannot open', nodeSqliteError(14)],
    ['a disk I/O error', nodeSqliteError(10)],
    ['permission denied', systemError('EACCES', -13)],
    ['too many open files', systemError('EMFILE', -24)],
    ['a Windows error whose low byte reads as corrupt', systemError('EUNKNOWN', -4085)],
    ['an error that only claims a corrupt code', Object.assign(new Error('x'), { errcode: 11 })],
    ['a thrown string', 'database disk image is malformed'],
    ['nothing at all', undefined]
  ])('calls any other failure one that can clear: %s', (_label, error) => {
    expect(classifyJournalOpenFailure(error)).toBe('journalUnavailable')
  })

  it('stops on a cause chain that loops back on itself', () => {
    const first = new Error('first')
    const second = new Error('second', { cause: first })
    Object.assign(first, { cause: second })
    expect(classifyJournalOpenFailure(first)).toBe('journalUnavailable')
  })
})

describe('journalOpenReadRefusal', () => {
  it('names the reason, keeps the message the code and the storage text only as the cause', () => {
    const log = recordingStructuredAgentSessionLogger()
    const storage = nodeSqliteError(26)
    const refusal = journalOpenReadRefusal(storage, log.logger, 'session-1')
    expect(refusal.message).toBe('agent_session_journal_unreadable')
    expect(refusal.refusal).toMatchObject({
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalCorrupt' }
    })
    expect(refusal.cause).toBe(storage)
    expect(log.entries).toEqual([
      {
        level: 'warn',
        message: 'opening the conversation for a read failed',
        fields: { scope: 'open-for-read', sessionId: 'session-1', error: storage }
      }
    ])
  })

  it('passes a refusal the open already raised through unchanged', () => {
    const raised = agentSessionRefusalError('agent_session_identity_required', {
      reason: 'recordMissing'
    })
    expect(
      journalOpenReadRefusal(raised, recordingStructuredAgentSessionLogger().logger, 's')
    ).toBe(raised)
  })
})

describe('createJournalOpenReadRefusals', () => {
  it('logs a session once per failure until it opens, and each session on its own', () => {
    const log = recordingStructuredAgentSessionLogger()
    const logged = () => log.entries.map((entry) => entry.fields.sessionId)
    const refusals = createJournalOpenReadRefusals(log.logger)
    const denied = systemError('EACCES', -13)
    const corrupt = nodeSqliteError(26)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const refusal = refusals.refusal('session-1', denied)
      expect(refusal.refusal).toMatchObject({ details: { reason: 'journalUnavailable' } })
      expect(refusal.cause).toBe(denied)
    }
    expect(logged()).toEqual(['session-1'])
    refusals.refusal('session-2', denied)
    expect(logged()).toEqual(['session-1', 'session-2'])
    expect(refusals.refusal('session-1', corrupt).refusal).toMatchObject({
      details: { reason: 'journalCorrupt' }
    })
    expect(logged()).toEqual(['session-1', 'session-2', 'session-1'])
    refusals.forget('session-1')
    refusals.refusal('session-1', corrupt)
    expect(log.scopes()).toEqual([
      'open-for-read',
      'open-for-read',
      'open-for-read',
      'open-for-read'
    ])
  })

  // Where it failed rides as the refusal's cause, so a chat whose reason changes is logged again
  // and the log names the row.
  it('logs a chat again when its load fails for another reason, naming where each failed', () => {
    const log = recordingStructuredAgentSessionLogger()
    const refusals = createJournalOpenReadRefusals(log.logger)
    const state = createJournalReducerState('session-1', 'epoch-1')
    const refusedFor = (load: Parameters<typeof failLoadOnUnloadableJournal>[1]) => {
      try {
        failLoadOnUnloadableJournal('session-1', load)
      } catch (error) {
        return error
      }
      throw new Error('the load was not refused')
    }
    const newer = refusedFor({ state, newer: { sequence: 7 }, damage: null })
    const damaged = refusedFor({
      state,
      newer: null,
      damage: { sequence: 3, cause: 'sequence-gap' }
    })

    for (const error of [newer, newer, damaged, damaged]) {
      refusals.refusal('session-1', error)
    }

    const causes = log.entries.map((entry) => {
      const error = entry.fields.error
      return error instanceof Error && error.cause instanceof Error ? error.cause.message : ''
    })
    expect(causes).toEqual([
      expect.stringContaining("newer Orca's row at sequence 7"),
      expect.stringContaining('damaged at sequence 3: sequence-gap')
    ])
  })

  // A load refused on its rows arrives already classified, and is logged once per session too.
  it("logs a load refused as a newer Orca's chat, or as damage, once per session until it opens", () => {
    const log = recordingStructuredAgentSessionLogger()
    const refusals = createJournalOpenReadRefusals(log.logger)
    const newer = journalOpenRefusalError(
      new AgentSessionJournalError('journal_read_only', 'a newer Orca wrote session-1')
    )
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(refusals.refusal('session-1', newer)).toBe(newer)
    }
    expect(log.entries.map((entry) => entry.fields.sessionId)).toEqual(['session-1'])
    refusals.refusal('session-2', newer)
    refusals.forget('session-1')
    refusals.refusal('session-1', newer)
    expect(log.entries.map((entry) => entry.fields.sessionId)).toEqual([
      'session-1',
      'session-2',
      'session-1'
    ])
    // A refusal that is not about loading the history is not this door's to log.
    refusals.refusal(
      'session-3',
      agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
    )
    expect(log.entries).toHaveLength(3)
  })
})

// Only an update gets past a journal a newer Orca wrote, so it has a reason of its own: a client
// that chose words by `journalUnavailable` said to try again, and retrying never cleared it.
describe('a journal a newer Orca wrote', () => {
  const readOnly = () =>
    new AgentSessionJournalError('journal_read_only', 'the journal uses a newer schema')

  it('refuses a write with its own reason, and the words released clients print', () => {
    // As the wire carries it (the mobile and older-client tests read this shape).
    expect(JSON.parse(JSON.stringify(journalOpenRefusal(readOnly())))).toEqual({
      code: 'agent_session_journal_unreadable',
      message: 'Chats were saved by a newer Orca. Update Orca to keep using them.',
      details: { reason: 'journalWrittenByNewerOrca' }
    })
    expect(journalOpenRefusalError(readOnly()).refusal).toMatchObject({
      details: { reason: 'journalWrittenByNewerOrca' }
    })
  })

  it('refuses a read with the same reason', () => {
    const { logger } = recordingStructuredAgentSessionLogger()
    expect(journalOpenReadRefusal(readOnly(), logger, 'session-1').refusal).toMatchObject({
      details: { reason: 'journalWrittenByNewerOrca' }
    })
    expect(
      createJournalOpenReadRefusals(logger).refusal('session-1', readOnly()).refusal
    ).toMatchObject({ details: { reason: 'journalWrittenByNewerOrca' } })
  })
})
