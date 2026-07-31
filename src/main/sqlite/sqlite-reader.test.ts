import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cellTextBudget, MAX_CELL_TEXT_CHARS, SqliteDatabaseReader, toCell } from './sqlite-reader'

const FIXTURE = fileURLToPath(new URL('./__fixtures__/sample-database.db', import.meta.url))

function withFixture<T>(run: (reader: SqliteDatabaseReader) => T): T {
  const reader = SqliteDatabaseReader.open(FIXTURE)
  try {
    return run(reader)
  } finally {
    reader.close()
  }
}

describe('SqliteDatabaseReader', () => {
  it('lists every table with its SELECT * columns', () => {
    withFixture((reader) => {
      const tables = reader.listTables()
      const names = tables.map((table) => table.name)
      expect(names).toContain('people')
      expect(names).toContain('without rowid')
      // sqlite_sequence exists because of the AUTOINCREMENT table, but is SQLite's bookkeeping, not user data.
      expect(names).not.toContain('sqlite_sequence')
      expect(names.filter((name) => name.startsWith('sqlite_'))).toEqual([])
      // FTS5 keeps its index and content in shadow tables; those are implementation detail, not user data.
      expect(names).toContain('docs')
      expect(names.filter((name) => name.startsWith('docs_') && name !== 'docs_archive')).toEqual(
        []
      )
      // ...but a user table that merely shares the prefix must survive.
      expect(names).toContain('docs_archive')
      expect(tables.find((table) => table.name === 'people')?.columns).toEqual([
        'id',
        'name',
        'score',
        'data',
        'note'
      ])
    })
  })

  it('omits virtual-table columns that SELECT * does not return', () => {
    withFixture((reader) => {
      // FTS5 adds hidden `docs` and `rank` columns; listing them would render phantom NULL cells.
      const page = reader.readTablePage('docs', 0, 1)
      expect(page.columns).toEqual(['title', 'body'])
      expect(page.rows[0]?.map((cell) => cell.text)).toEqual(['first', 'hello world'])
    })
  })

  it('counts rows only for the table asked about', () => {
    withFixture((reader) => {
      expect(reader.countRows('people')).toBe(305)
      expect(reader.countRows('settings')).toBe(2)
    })
  })

  it('decodes every value type', () => {
    withFixture((reader) => {
      const page = reader.readTablePage('people', 0, 3)
      expect(page.rows[0]).toEqual([
        { type: 'integer', text: '1' },
        { type: 'text', text: 'Ada' },
        { type: 'real', text: '99.5' },
        { type: 'blob', text: 'BLOB (5 B)' },
        { type: 'null', text: '' }
      ])
      expect(page.rows[1]?.[2]).toEqual({ type: 'null', text: '' })
      expect(page.rows[1]?.[4]).toEqual({ type: 'text', text: 'unicode: héllo wörld ✅' })
      expect(page.rows[2]?.[4]).toEqual({ type: 'text', text: '' })
      expect(page.rows[2]?.[2]).toEqual({ type: 'real', text: '-0.25' })
    })
  })

  it('truncates an oversized cell for display and flags it', () => {
    withFixture((reader) => {
      const note = reader.readTablePage('people', 3, 1).rows[0]?.[4]
      expect(note?.truncated).toBe(true)
      expect(note?.text).toHaveLength(MAX_CELL_TEXT_CHARS)
    })
  })

  it('pages in a stable order past the first chunk', () => {
    withFixture((reader) => {
      const page = reader.readTablePage('people', 300, 5)
      expect(page.rows).toHaveLength(5)
      expect(page.rows[0]?.[1]).toEqual({ type: 'text', text: 'person-396' })
      expect(page.rows[4]?.[1]).toEqual({ type: 'text', text: 'person-400' })
    })
  })

  it('returns fewer rows than asked at the end of the table', () => {
    withFixture((reader) => {
      expect(reader.readTablePage('people', 303, 50).rows).toHaveLength(2)
      expect(reader.readTablePage('people', 999, 10).rows).toHaveLength(0)
    })
  })

  it('reads WITHOUT ROWID tables, ordering by their primary key', () => {
    withFixture((reader) => {
      const page = reader.readTablePage('settings', 0, 10)
      expect(page.columns).toEqual(['key', 'value'])
      expect(page.rows.map((row) => row[0]?.text)).toEqual(['locale', 'theme'])
    })
  })

  it('includes generated columns with their computed values', () => {
    withFixture((reader) => {
      const page = reader.readTablePage('generated', 0, 2)
      expect(page.columns).toEqual(['a', 'virt', 'stor', 'z'])
      expect(page.rows[0]?.map((cell) => cell.text)).toEqual(['10', '11', '20', 'ten'])
    })
  })

  it('reads columns added by ALTER TABLE as their default, not NULL', () => {
    withFixture((reader) => {
      const page = reader.readTablePage('altered', 0, 2)
      expect(page.columns).toEqual(['a', 'added', 'n'])
      expect(page.rows[0]?.map((cell) => cell.text)).toEqual(['1', 'from-default', '42'])
    })
  })

  it('reads a table whose name and columns need quoting', () => {
    withFixture((reader) => {
      const page = reader.readTablePage('odd names', 0, 1)
      expect(page.columns).toEqual(['select', 'group by', 'limit'])
      expect(page.rows[0]?.map((cell) => cell.text)).toEqual(['a', '1', 'b'])
    })
  })

  it('does not mistake a table named "without rowid" for a WITHOUT ROWID table', () => {
    withFixture((reader) => {
      expect(reader.readTablePage('without rowid', 0, 1).rows[0]?.[0]).toEqual({
        type: 'text',
        text: 'present'
      })
    })
  })

  it('names the missing table instead of building a query from it', () => {
    withFixture((reader) => {
      expect(() => reader.readTablePage('nope"; drop table people; --', 0, 1)).toThrow(
        /does not exist/
      )
    })
  })

  it('rejects a file that is not a SQLite database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-sqlite-'))
    const notADatabase = join(dir, 'fake.db')
    await writeFile(notADatabase, 'this is plain text, not a database')
    expect(() => SqliteDatabaseReader.open(notADatabase)).toThrow()
  })

  it('reports a missing file rather than creating one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-sqlite-'))
    expect(() => SqliteDatabaseReader.open(join(dir, 'absent.db'))).toThrow(/does not exist/)
  })
})

describe('cellTextBudget', () => {
  it('keeps the full per-cell budget for ordinary tables', () => {
    expect(cellTextBudget(5, 200)).toBe(MAX_CELL_TEXT_CHARS)
  })

  it('shrinks the budget so a very wide table cannot blow up one response', () => {
    const budget = cellTextBudget(2000, 200)
    expect(budget).toBeLessThan(MAX_CELL_TEXT_CHARS)
    expect(budget * 2000 * 200).toBeLessThanOrEqual(4 * 1024 * 1024)
  })
})

describe('toCell', () => {
  it('keeps 64-bit integers exact', () => {
    expect(toCell(9223372036854775807n)).toEqual({ type: 'integer', text: '9223372036854775807' })
  })

  it('separates integers from reals', () => {
    expect(toCell(3).type).toBe('integer')
    expect(toCell(3.5).type).toBe('real')
  })
})
