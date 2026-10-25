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
    // A census over the real schema, not two hand-picked cases: a statement that lands here
    // without a target is sent on every boot and takes the lock the pre-check exists to avoid.
    // requireSchemaLockTarget is what boot calls, so this fails the same way boot would.
    for (const statement of relayPostgresSchemaStatements()) {
      expect(() => requireSchemaLockTarget(statement)).not.toThrow()
    }
  })

  it('pre-checks every lock-taking statement, with no exceptions', () => {
    // The invariant the rule comment beside SCHEMA depends on: nothing that takes a relation lock
    // reaches the server on a warm boot. A statement with no target breaks it.
    const unchecked = lockTakingStatements().filter(
      (statement) => schemaLockTarget(statement) === undefined
    )
    expect(unchecked).toEqual([])
    expect(lockTakingStatements().length).toBeGreaterThan(0)
  })

  it('derives a target through the comment block a split schema glues on', () => {
    // Not vacuous: SCHEMA really does carry a comment-prefixed statement, and it is a CREATE INDEX
    // on relay_connection_bases. Classifying the raw text would give it no target at all.
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
    // Its body is a PL/pgSQL block full of commas and parentheses. Reading the tag as anything but
    // opaque would change the text classification sees, and it is the only such statement relay has.
    const doBlock = relayPostgresSchemaStatements().find((statement) => statement.startsWith('DO '))
    expect(doBlock).toBeDefined()
    expect(sqlWithoutComments(doBlock!)).toBe(doBlock)
    expect(takesRelationLock(doBlock!)).toBe(false)
  })
})
