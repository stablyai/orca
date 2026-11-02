import { describe, expect, it } from 'vitest'
import {
  requireSchemaLockTarget,
  schemaLockTarget,
  sqlWithoutComments,
  takesRelationLock
} from '@orca-cloud/postgres-schema'
import { relayPostgresSchemaStatements } from './database.js'

function lockTakingStatements(): string[] {
  return relayPostgresSchemaStatements().filter(takesRelationLock)
}

describe('relay boot-time lock targets', () => {
  it('derives a target for every CREATE INDEX and every ALTER TABLE ADD COLUMN', () => {
    // Use boot’s classifier on every real statement; an unclassified one would lock tables on every warm boot.
    for (const statement of relayPostgresSchemaStatements()) {
      expect(() => requireSchemaLockTarget(statement)).not.toThrow()
    }
  })

  it('pre-checks every lock-taking statement, with no exceptions', () => {
    const unchecked = lockTakingStatements().filter(
      (statement) => schemaLockTarget(statement) === undefined
    )
    expect(unchecked).toEqual([])
    expect(lockTakingStatements().length).toBeGreaterThan(0)
  })

  it('derives a target through the comment block a split schema glues on', () => {
    // Real split-schema statements carry comment prefixes; raw-text classification would miss their CREATE INDEX.
    const commented = relayPostgresSchemaStatements().filter((statement) =>
      statement.startsWith('--')
    )
    expect(commented.length).toBeGreaterThan(0)
    for (const statement of commented) {
      if (!takesRelationLock(statement)) continue
      expect(schemaLockTarget(statement)).toBeDefined()
    }
    expect(commented.map(schemaLockTarget)).toContainEqual({
      kind: 'index',
      table: 'relay_connection_bases',
      name: 'relay_connection_bases_active_deadline',
      skipWhen: 'present'
    })
  })

  it('leaves the dollar-quoted statement-stats migration byte-identical', () => {
    // Dollar-quoted PL/pgSQL commas/parentheses must remain opaque to classification.
    const doBlock = relayPostgresSchemaStatements().find((statement) => statement.startsWith('DO '))
    expect(doBlock).toBeDefined()
    expect(sqlWithoutComments(doBlock!)).toBe(doBlock)
    expect(takesRelationLock(doBlock!)).toBe(false)
  })
})
