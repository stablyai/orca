import { describe, expect, it } from 'vitest'
import {
  requireSchemaLockTarget,
  schemaLockTarget
} from './schema-lock-target.js'

describe('catalog name folding', () => {

  it('unescapes a doubled quote and leaves the qualified table text as written', () => {
    expect(schemaLockTarget('ALTER TABLE App."My Table" ADD COLUMN "od""d" TEXT')).toEqual({
      kind: 'column',
      table: 'App."My Table"',
      name: 'od"d',
      skipWhen: 'present'
    })
  })

  it('reads a column drop as skipped once the column is gone, and refuses one without IF EXISTS', () => {
    expect(schemaLockTarget('ALTER TABLE t DROP COLUMN IF EXISTS Old_Col')).toEqual({
      kind: 'column',
      table: 't',
      name: 'old_col',
      skipWhen: 'absent'
    })
    expect(() => requireSchemaLockTarget('ALTER TABLE t DROP COLUMN old_col')).toThrow(
      'unparsed_schema_lock_target'
    )
  })
})

describe('square brackets in an ALTER TABLE', () => {
  it('does not read an array-default comma as a second subcommand', () => {
    expect(() =>
      requireSchemaLockTarget('ALTER TABLE t ADD COLUMN c bigint[] DEFAULT ARRAY[1, 2]')
    ).not.toThrow()
  })

  it('still catches a second subcommand after an array default', () => {
    expect(() =>
      requireSchemaLockTarget(
        'ALTER TABLE t ADD COLUMN a bigint[] DEFAULT ARRAY[1, 2], ADD COLUMN b TEXT'
      )
    ).toThrow(/unparsed_schema_lock_target/)
  })
})

describe('dollar-quoted bodies', () => {

  it('reads an inner $$ inside a tagged body as text, not as the close', () => {
    // The closing delimiter has to match the opening tag, so the comma and the comment marker
    // between the inner $$ pair are still inside the body.
    const statement = 'ALTER TABLE t ADD COLUMN c TEXT DEFAULT $tag$ a $$ -- b, c $$ d $tag$'
    expect(() => requireSchemaLockTarget(statement)).not.toThrow()
    expect(schemaLockTarget(statement)).toEqual({
      kind: 'column',
      table: 't',
      name: 'c',
      skipWhen: 'present'
    })
  })

  it('still catches a second subcommand after a dollar-quoted default', () => {
    expect(() =>
      requireSchemaLockTarget('ALTER TABLE t ADD COLUMN a TEXT DEFAULT $$x, y$$, ADD COLUMN b TEXT')
    ).toThrow(/unparsed_schema_lock_target/)
  })
})
