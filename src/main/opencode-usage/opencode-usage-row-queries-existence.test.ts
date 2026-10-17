import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { NodeSqliteStatement } from '../sqlite/node-sqlite-statement'
import { selectUsageRows } from './opencode-usage-row-queries'
import {
  writeOpenCodeUsageDatabase,
  type OpenCodeUsageFixtureGeneration
} from './opencode-usage-sqlite-fixture'

const directories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function countGateVisits(generation: OpenCodeUsageFixtureGeneration, activeIndex: number | 'all') {
  const directory = mkdtempSync(join(tmpdir(), 'orca-usage-existence-'))
  directories.push(directory)
  const file = join(directory, 'opencode.db')
  const sessions = Array.from({ length: 512 }, (_, index) => ({
    id: `session-${index.toString().padStart(4, '0')}`,
    directory,
    tokensInput: activeIndex === 'all' || activeIndex === index ? 100 : 0
  }))
  writeOpenCodeUsageDatabase(file, {
    generation,
    legacySessions: sessions,
    v2Sessions: sessions
  })
  const db = new Database(file, { readonly: true })
  const instrumented = new DatabaseSync(file, { readOnly: true })
  let visits = 0
  instrumented.function('probe_tokens', (tokens) => {
    visits++
    return tokens
  })
  const prepare = db.prepare.bind(db)
  const gates: string[] = []
  // Count real SQLite predicate evaluations; the callback returns the unchanged token value.
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    if (sql.includes('WHERE s.tokens_input +') && !sql.includes('ORDER BY')) {
      gates.push(sql)
      return new NodeSqliteStatement(
        instrumented.prepare(
          sql.replace('WHERE s.tokens_input +', 'WHERE probe_tokens(s.tokens_input) +')
        )
      )
    }
    return prepare(sql)
  })
  try {
    const rows = selectUsageRows(db)
    return { rows, visits, gates }
  } finally {
    db.close()
    instrumented.close()
  }
}

describe('OpenCode session usage existence gate', () => {
  it.each(['v1', 'v2-only', 'migrated'] as const)(
    'stops after the first matching session on %s without truncating returned usage',
    (generation) => {
      const { rows, visits, gates } = countGateVisits(generation, 'all')
      expect(gates).toHaveLength(1)
      expect(visits).toBe(1)
      expect(rows).toHaveLength(512)
      expect(rows[0].id).toBe('session-0000')
      expect(rows.at(-1)?.id).toBe('session-0511')
      expect(rows.every((row) => JSON.parse(row.data).tokens.input === 100)).toBe(true)
    }
  )

  it('keeps searching when usage appears only at the end', () => {
    const { rows, visits } = countGateVisits('v2-only', 511)
    expect(visits).toBe(512)
    expect(rows.map((row) => row.id)).toEqual(['session-0511'])
  })

  it('exhausts the table and preserves the empty result when no session records usage', () => {
    const { rows, visits } = countGateVisits('v2-only', -1)
    expect(visits).toBe(512)
    expect(rows).toEqual([])
  })
})
