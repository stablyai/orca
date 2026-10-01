import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { NO_LEGACY_JOURNAL_RECORDS, openJournalDatabase } from './journal-database'
import {
  classifyJournalOpenFailure,
  createJournalOpenReadRefusals,
  journalOpenReadRefusal,
  journalOpenRefusal,
  journalOpenRefusalError
} from './journal-open-failure'
import { AgentSessionJournalError } from './journal-write-guards'
import { journalDatabasePath } from './journal-host-database'
import { replayJournal } from './journal-open'

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

  it("reads the Bun driver's corrupt code as corrupt", () => {
    const error = Object.assign(new Error('file is not a database'), {
      name: 'SQLiteError',
      code: 'SQLITE_NOTADB',
      errno: 26
    })
    expect(classifyJournalOpenFailure(error)).toBe('journalCorrupt')
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
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const storage = nodeSqliteError(26)
    const refusal = journalOpenReadRefusal(storage)
    expect(refusal.message).toBe('agent_session_journal_unreadable')
    expect(refusal.refusal).toMatchObject({
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalCorrupt' }
    })
    expect(refusal.cause).toBe(storage)
    vi.restoreAllMocks()
  })

  it('passes a refusal the open already raised through unchanged', () => {
    const raised = agentSessionRefusalError('agent_session_identity_required', {
      reason: 'recordMissing'
    })
    expect(journalOpenReadRefusal(raised)).toBe(raised)
  })
})

describe('createJournalOpenReadRefusals', () => {
  it('logs a session once per failure until it opens, and each session on its own', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refusals = createJournalOpenReadRefusals()
    const denied = systemError('EACCES', -13)
    const corrupt = nodeSqliteError(26)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const refusal = refusals.refusal('session-1', denied)
      expect(refusal.refusal).toMatchObject({ details: { reason: 'journalUnavailable' } })
      expect(refusal.cause).toBe(denied)
    }
    expect(warn).toHaveBeenCalledTimes(1)
    refusals.refusal('session-2', denied)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(refusals.refusal('session-1', corrupt).refusal).toMatchObject({
      details: { reason: 'journalCorrupt' }
    })
    expect(warn).toHaveBeenCalledTimes(3)
    refusals.forget('session-1')
    refusals.refusal('session-1', corrupt)
    expect(warn).toHaveBeenCalledTimes(4)
    vi.restoreAllMocks()
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
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(journalOpenReadRefusal(readOnly()).refusal).toMatchObject({
      details: { reason: 'journalWrittenByNewerOrca' }
    })
    expect(createJournalOpenReadRefusals().refusal('session-1', readOnly()).refusal).toMatchObject({
      details: { reason: 'journalWrittenByNewerOrca' }
    })
    vi.restoreAllMocks()
  })
})
