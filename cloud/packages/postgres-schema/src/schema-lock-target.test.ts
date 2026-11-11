import { describe, expect, it } from 'vitest'
import {
  requireSchemaLockTarget,
  schemaLockTarget,
  sqlWithoutComments
} from './schema-lock-target.js'

describe('sqlWithoutComments', () => {

  it('closes the inner block comment first when they nest', () => {
    expect(sqlWithoutComments('ALTER TABLE t /* a /* b */ c */ ADD COLUMN d TEXT')).toBe(
      'ALTER TABLE t   ADD COLUMN d TEXT'
    )
  })

  it('leaves a comment marker inside a string literal alone', () => {
    expect(sqlWithoutComments(`ALTER TABLE t ADD COLUMN c TEXT DEFAULT '-- not a comment'`)).toBe(
      `ALTER TABLE t ADD COLUMN c TEXT DEFAULT '-- not a comment'`
    )
  })
})

describe('catalog name folding', () => {

  it('unescapes a doubled quote and leaves the qualified table text as written', () => {
    expect(schemaLockTarget('ALTER TABLE App."My Table" ADD COLUMN "od""d" TEXT')).toEqual({
      kind: 'column',
      table: 'App."My Table"',
      name: 'od"d',
      skipWhen: 'present'
    })
  })
})

describe('square brackets in an ALTER TABLE', () => {
  it.each([
    ['an array type', 'ALTER TABLE t ADD COLUMN c bigint[] DEFAULT ARRAY[1, 2]'],
    ['a nested array default', "ALTER TABLE t ADD COLUMN c TEXT[] DEFAULT ARRAY['a', 'b']"]
  ])('does not read a comma inside %s as a second subcommand', (_label, statement) => {
    expect(() => requireSchemaLockTarget(statement)).not.toThrow()
  })

  it('still catches a second subcommand after an array default', () => {
    expect(() =>
      requireSchemaLockTarget('ALTER TABLE t ADD COLUMN a bigint[] DEFAULT ARRAY[1, 2], ADD COLUMN b TEXT')
    ).toThrow(/unparsed_schema_lock_target/)
  })
})

describe('multi-action ALTER TABLE', () => {
  it('throws rather than deriving only the first subcommand', () => {
    // Skipping on the first subcommand would permanently drop every later action.
    const statement =
      'ALTER TABLE t ADD COLUMN IF NOT EXISTS a TEXT, ADD COLUMN IF NOT EXISTS b TEXT'
    expect(schemaLockTarget(statement)).toEqual({
      kind: 'column',
      table: 't',
      name: 'a',
      skipWhen: 'present'
    })
    expect(() => requireSchemaLockTarget(statement)).toThrow(/unparsed_schema_lock_target/)
  })
})

describe('dollar-quoted bodies', () => {

  it('reads an inner $$ inside a tagged body as text, not as the close', () => {
    // The closing delimiter has to match the opening tag, so the comma and the comment marker
    // between the inner $$ pair are still inside the body.
    const statement = 'ALTER TABLE t ADD COLUMN c TEXT DEFAULT $tag$ a $$ -- b, c $$ d $tag$'
    expect(sqlWithoutComments(statement)).toBe(statement)
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
