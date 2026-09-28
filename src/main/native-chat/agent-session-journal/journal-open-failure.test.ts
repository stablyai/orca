import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openJournalDatabase } from './journal-database'
import { classifyJournalOpenFailure } from './journal-open-failure'
import { loadJournal } from './journal-open'
import { journalDatabaseFile } from './journal-paths'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-open-failure-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** What the journal's own open throws for the file as it stands. */
function openFailure(): unknown {
  try {
    loadJournal(root, 'session-1')
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
    await writeFile(journalDatabaseFile(root), 'not a database '.repeat(64))
    const error = openFailure()
    expect(error).toMatchObject({ errcode: 26 })
    expect(classifyJournalOpenFailure(error)).toBe('journalCorrupt')
  })

  it('calls a journal whose pages are damaged corrupt', async () => {
    const path = journalDatabaseFile(root)
    const opened = openJournalDatabase(path)
    opened.db.exec('PRAGMA journal_mode = DELETE')
    opened.db.close()
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
