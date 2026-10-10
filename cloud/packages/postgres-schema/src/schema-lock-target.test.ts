import { describe, expect, it } from 'vitest'
import { schemaDeferrable } from './apply-postgres-schema.js'
import {
  requireSchemaLockTarget,
  schemaLockTarget,
  sqlWithoutComments,
  takesRelationLock
} from './schema-lock-target.js'

// The shape a schema string split on ';' actually produces: the comment written above a statement
// arrives glued to the front of it.
const COMMENTED_INDEX = `-- Why: the maintenance sweep matches (active, deadline) while inactive
-- bases accumulate unboundedly.
CREATE INDEX IF NOT EXISTS relay_connection_bases_active_deadline
  ON relay_connection_bases(active, deadline)`

const COMMENTED_TABLE = `-- Rehoming is bidirectional, but tables created before that carry the
-- original single-region column check.
CREATE TABLE IF NOT EXISTS relay_cells (
  cell_id TEXT PRIMARY KEY
)`

describe('sqlWithoutComments', () => {
  it('strips the line comments a split schema glues above a statement', () => {
    expect(sqlWithoutComments(COMMENTED_INDEX)).toMatch(/^CREATE INDEX IF NOT EXISTS/)
  })

  it('strips a leading block comment', () => {
    expect(sqlWithoutComments('/* note */\n  ALTER TABLE t ADD COLUMN c TEXT')).toBe(
      'ALTER TABLE t ADD COLUMN c TEXT'
    )
  })

  it('strips a comment sitting between two keywords', () => {
    expect(sqlWithoutComments('ALTER TABLE t ADD /* note */ COLUMN c TEXT')).toBe(
      'ALTER TABLE t ADD   COLUMN c TEXT'
    )
  })

  it('strips a trailing comment', () => {
    expect(sqlWithoutComments('SELECT 1 -- note')).toBe('SELECT 1')
  })

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

  it('leaves a comment marker inside a quoted identifier alone', () => {
    expect(sqlWithoutComments('ALTER TABLE t ADD COLUMN "a/* b */c" TEXT')).toBe(
      'ALTER TABLE t ADD COLUMN "a/* b */c" TEXT'
    )
  })
})

describe('comments between keywords', () => {
  // Before this, the classification regexes and the must-parse shapes both needed `ADD COLUMN`
  // contiguous, so this statement derived NO target and threw NOTHING: the DDL ran with no
  // pre-check, taking ACCESS EXCLUSIVE on every boot.
  it('derives a column target through a comment between ADD and COLUMN', () => {
    expect(requireSchemaLockTarget('ALTER TABLE t ADD /* note */ COLUMN c TEXT')).toEqual({
      kind: 'column',
      table: 't',
      name: 'c',
      skipWhen: 'present'
    })
  })

  it('derives an index target through a line comment before ON', () => {
    expect(
      requireSchemaLockTarget('CREATE INDEX IF NOT EXISTS i\n-- why this index exists\nON t(c)')
    ).toEqual({ kind: 'index', table: 't', name: 'i', skipWhen: 'present' })
  })

  it('still counts a commented statement as taking a relation lock', () => {
    expect(takesRelationLock('/* note */ ALTER TABLE t ADD COLUMN c TEXT')).toBe(true)
  })

  it('does not read a comment marker inside a quoted name as a comment', () => {
    expect(schemaLockTarget('ALTER TABLE t ADD COLUMN "a--b" TEXT')).toEqual({
      kind: 'column',
      table: 't',
      name: 'a--b',
      skipWhen: 'present'
    })
  })
})

describe('catalog name folding', () => {
  it('reads a quoted identifier containing a dot as one name', () => {
    expect(schemaLockTarget('CREATE INDEX IF NOT EXISTS "a.b" ON t(c)')).toEqual({
      kind: 'index',
      table: 't',
      name: 'a.b',
      skipWhen: 'present'
    })
  })

  it('folds an unquoted name to lower case, the form the catalog stores', () => {
    expect(schemaLockTarget('CREATE INDEX IF NOT EXISTS Foo ON Bar(c)')).toEqual({
      kind: 'index',
      table: 'Bar',
      name: 'foo',
      skipWhen: 'present'
    })
  })

  it('keeps a quoted name in its written case', () => {
    expect(schemaLockTarget('CREATE INDEX IF NOT EXISTS public."Mixed.Name" ON t(c)')).toEqual({
      kind: 'index',
      table: 't',
      name: 'Mixed.Name',
      skipWhen: 'present'
    })
  })

  it('unescapes a doubled quote and leaves the qualified table text as written', () => {
    expect(schemaLockTarget('ALTER TABLE App."My Table" ADD COLUMN "od""d" TEXT')).toEqual({
      kind: 'column',
      table: 'App."My Table"',
      name: 'od"d',
      skipWhen: 'present'
    })
  })

  it('folds an unquoted column name too', () => {
    expect(schemaLockTarget('ALTER TABLE t ADD COLUMN IF NOT EXISTS HostCooldownMs BIGINT')).toEqual(
      { kind: 'column', table: 't', name: 'hostcooldownms', skipWhen: 'present' }
    )
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


describe('takesRelationLock', () => {
  it('classifies a comment-prefixed CREATE INDEX by its first SQL keyword', () => {
    expect(takesRelationLock(COMMENTED_INDEX)).toBe(true)
  })

  it('classifies a comment-prefixed CREATE TABLE as taking no relation lock', () => {
    expect(takesRelationLock(COMMENTED_TABLE)).toBe(false)
  })

  it('counts every ALTER TABLE, including the constraint swaps', () => {
    expect(takesRelationLock('ALTER TABLE t DROP CONSTRAINT IF EXISTS c')).toBe(true)
  })
})

describe('schemaLockTarget', () => {
  it('derives an index target through the comments above it', () => {
    expect(schemaLockTarget(COMMENTED_INDEX)).toEqual({
      kind: 'index',
      table: 'relay_connection_bases',
      name: 'relay_connection_bases_active_deadline',
      skipWhen: 'present'
    })
  })

  it('derives an index target across the line break before ON', () => {
    expect(
      schemaLockTarget(`CREATE INDEX IF NOT EXISTS relay_reservation_assignment
  ON relay_control_connection_reservations(
    user_id, relay_host_id
  )`)
    ).toEqual({
      kind: 'index',
      table: 'relay_control_connection_reservations',
      name: 'relay_reservation_assignment',
      skipWhen: 'present'
    })
  })

  it('derives a unique concurrent index target', () => {
    expect(schemaLockTarget('CREATE UNIQUE INDEX CONCURRENTLY i ON t(c)')).toEqual({
      kind: 'index',
      table: 't',
      name: 'i',
      skipWhen: 'present'
    })
  })

  it('keeps the schema qualification on the table and drops it from the object name', () => {
    // `table` is fed to to_regclass, which needs the qualification; `name` is matched against
    // relname, which stores the bare identifier.
    expect(schemaLockTarget('CREATE INDEX IF NOT EXISTS app.i ON app.t(c)')).toEqual({
      kind: 'index',
      table: 'app.t',
      name: 'i',
      skipWhen: 'present'
    })
  })

  it('unquotes a quoted identifier, doubled quote included', () => {
    expect(schemaLockTarget('CREATE INDEX IF NOT EXISTS "od""d" ON "My Table"(c)')).toEqual({
      kind: 'index',
      table: '"My Table"',
      name: 'od"d',
      skipWhen: 'present'
    })
  })

  it('derives a column target from a multi-line ADD COLUMN IF NOT EXISTS', () => {
    expect(
      schemaLockTarget(`ALTER TABLE relay_region_rehome_control
     ADD COLUMN IF NOT EXISTS host_cooldown_ms BIGINT NOT NULL
     DEFAULT 604800000`)
    ).toEqual({
      kind: 'column',
      table: 'relay_region_rehome_control',
      name: 'host_cooldown_ms',
      skipWhen: 'present'
    })
  })

  it('derives a column target without IF NOT EXISTS', () => {
    expect(schemaLockTarget('ALTER TABLE ONLY t ADD COLUMN c TEXT')).toEqual({
      kind: 'column',
      table: 't',
      name: 'c',
      skipWhen: 'present'
    })
  })

  it('skips an ADD CONSTRAINT once the constraint name is there', () => {
    expect(schemaLockTarget('ALTER TABLE t ADD CONSTRAINT c CHECK (x > 0)')).toEqual({
      kind: 'constraint',
      table: 't',
      name: 'c',
      skipWhen: 'present'
    })
  })

  it('skips a DROP CONSTRAINT IF EXISTS when the constraint is already gone', () => {
    // The inverse polarity: nothing to drop is nothing to do.
    expect(schemaLockTarget('ALTER TABLE t DROP CONSTRAINT IF EXISTS c')).toEqual({
      kind: 'constraint',
      table: 't',
      name: 'c',
      skipWhen: 'absent'
    })
  })

  it('derives a constraint target across a line break', () => {
    expect(
      schemaLockTarget(`ALTER TABLE relay_region_rehome_attempts
     ADD CONSTRAINT relay_region_rehome_attempts_preferred_region_valid
     CHECK (preferred_region IN ('us-central1'))`)
    ).toEqual({
      kind: 'constraint',
      table: 'relay_region_rehome_attempts',
      name: 'relay_region_rehome_attempts_preferred_region_valid',
      skipWhen: 'present'
    })
  })

  it('gives CREATE TABLE IF NOT EXISTS no target', () => {
    expect(schemaLockTarget(COMMENTED_TABLE)).toBeUndefined()
  })
})

// Each of these reads as an index or column statement and each fails to yield a target. Letting any
// of them through would send an unchecked lock-taking statement on every boot.
const MALFORMED = [
  ['an index with no ON clause', 'CREATE INDEX IF NOT EXISTS i'],
  ['an auto-named index', 'CREATE INDEX ON t(c)'],
  ['an auto-named unique concurrent index', 'CREATE UNIQUE INDEX CONCURRENTLY ON t(c)'],
  ['an index whose name ran into a comment', '-- note\nCREATE INDEX IF NOT EXISTS\nON t(c)'],
  ['an ALTER TABLE with no table', 'ALTER TABLE ADD COLUMN c TEXT'],
  ['an ADD COLUMN with no column', 'ALTER TABLE t ADD COLUMN'],
  ['an ADD COLUMN IF NOT EXISTS with no column', 'ALTER TABLE t ADD COLUMN IF NOT EXISTS']
] as const

describe('requireSchemaLockTarget', () => {
  it.each(MALFORMED)('throws with the statement text on %s', (_label, statement) => {
    expect(() => requireSchemaLockTarget(statement)).toThrow(/unparsed_schema_lock_target/)
  })

  it('names the offending statement in the error', () => {
    expect(() => requireSchemaLockTarget('CREATE INDEX ON t(c)')).toThrow(
      'unparsed_schema_lock_target: CREATE INDEX ON t(c)'
    )
  })

  it('returns the target for a statement that parses', () => {
    expect(requireSchemaLockTarget(COMMENTED_INDEX)).toEqual({
      kind: 'index',
      table: 'relay_connection_bases',
      name: 'relay_connection_bases_active_deadline',
      skipWhen: 'present'
    })
  })

  it.each([
    ['CREATE TABLE IF NOT EXISTS t (id TEXT)'],
    ['ALTER TABLE t ALTER COLUMN c SET DEFAULT 0']
  ])('leaves %s alone, because no target is expected of it', (statement) => {
    expect(requireSchemaLockTarget(statement)).toBeUndefined()
  })
})

describe('multi-action ALTER TABLE', () => {
  it('throws rather than deriving only the first subcommand', () => {
    // Deriving `a` and skipping on it would drop `b` for the life of the database, and the first
    // subcommand parses fine, so nothing else here would catch it.
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

  it('throws on a constraint swap written as one statement', () => {
    expect(() =>
      requireSchemaLockTarget(
        'ALTER TABLE t DROP CONSTRAINT IF EXISTS old, ADD CONSTRAINT new CHECK (x > 0)'
      )
    ).toThrow(/unparsed_schema_lock_target/)
  })

  it.each([
    ['a parenthesised type', 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a NUMERIC(10, 2)'],
    ['a CHECK body', "ALTER TABLE t ADD CONSTRAINT c CHECK (r IN ('us-central1', 'asia-east2'))"],
    ['a quoted comma', `ALTER TABLE t ADD COLUMN IF NOT EXISTS a TEXT DEFAULT 'x, y'`],
    ['a doubled quote before a comma', `ALTER TABLE t ADD COLUMN a TEXT DEFAULT 'it''s, fine'`],
    ['a trailing line comment', 'ALTER TABLE t ADD COLUMN a TEXT -- one, two'],
    ['a trailing block comment', 'ALTER TABLE t ADD COLUMN a TEXT /* one, two */']
  ])('does not throw on %s', (_label, statement) => {
    expect(() => requireSchemaLockTarget(statement)).not.toThrow()
  })

  it('derives through a block comment sitting where the column name belongs', () => {
    expect(requireSchemaLockTarget('ALTER TABLE t ADD COLUMN /* note */ a TEXT')).toEqual({
      kind: 'column',
      table: 't',
      name: 'a',
      skipWhen: 'present'
    })
  })

  it('leaves a multi-column CREATE INDEX alone', () => {
    expect(() => requireSchemaLockTarget('CREATE INDEX IF NOT EXISTS i ON t(a, b)')).not.toThrow()
  })
})

describe('dollar-quoted bodies', () => {
  it('does not read a comment marker inside a dollar-quoted default as a comment', () => {
    expect(sqlWithoutComments('ALTER TABLE t ADD COLUMN c TEXT DEFAULT $$--$$')).toBe(
      'ALTER TABLE t ADD COLUMN c TEXT DEFAULT $$--$$'
    )
    expect(requireSchemaLockTarget('ALTER TABLE t ADD COLUMN c TEXT DEFAULT $$--$$')).toEqual({
      kind: 'column',
      table: 't',
      name: 'c',
      skipWhen: 'present'
    })
  })

  it('does not count a comma inside a dollar-quoted default as a second subcommand', () => {
    expect(() =>
      requireSchemaLockTarget('ALTER TABLE t ADD COLUMN c TEXT DEFAULT $$a, b$$')
    ).not.toThrow()
  })

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

  it('leaves a numbered placeholder alone, because a tag cannot start with a digit', () => {
    expect(sqlWithoutComments('ALTER TABLE t ADD COLUMN c TEXT -- $1 and $2')).toBe(
      'ALTER TABLE t ADD COLUMN c TEXT'
    )
  })

  it('treats an unterminated dollar quote as opaque to the end', () => {
    expect(sqlWithoutComments('ALTER TABLE t ADD COLUMN c TEXT DEFAULT $$ -- unterminated')).toBe(
      'ALTER TABLE t ADD COLUMN c TEXT DEFAULT $$ -- unterminated'
    )
  })
})

describe('schemaLockTarget storage parameters', () => {
  it('reads a storage parameter as a name=value target the catalog can be asked about', () => {
    expect(schemaLockTarget('ALTER TABLE t SET (fillfactor = 70)')).toEqual({
      kind: 'reloption',
      table: 't',
      name: 'fillfactor=70',
      skipWhen: 'present'
    })
  })

  it('folds the option name but keeps the value as written, the way pg_class stores the pair', () => {
    expect(schemaLockTarget('ALTER TABLE t SET (FillFactor=70)')?.name).toBe('fillfactor=70')
  })

  it('makes a changed value a different target, so it re-runs instead of skipping', () => {
    // The failure this prevents: matching on the option name alone would read `fillfactor=100` as
    // already satisfying `fillfactor = 70` and skip the statement for the life of the database.
    const seventy = schemaLockTarget('ALTER TABLE t SET (fillfactor = 70)')
    const eighty = schemaLockTarget('ALTER TABLE t SET (fillfactor = 80)')
    expect(seventy?.name).not.toBe(eighty?.name)
  })

  it('refuses a multi-option SET rather than skipping on only the first option', () => {
    // Same reason a multi-action ALTER TABLE is refused: skipping on one option would silently
    // drop the others for good.
    expect(() =>
      requireSchemaLockTarget('ALTER TABLE t SET (fillfactor = 70, autovacuum_enabled = false)')
    ).toThrow(/unparsed_schema_lock_target/)
  })

  it('fails the boot on a SET whose shape it cannot read, rather than sending it unchecked', () => {
    // A storage parameter takes a relation lock, so no target means the lock is taken on every
    // boot. RESET has no value to compare and is not supported.
    expect(() => requireSchemaLockTarget('ALTER TABLE t RESET (fillfactor)')).not.toThrow()
    expect(() => requireSchemaLockTarget('ALTER TABLE t SET (fillfactor)')).toThrow(
      /unparsed_schema_lock_target/
    )
  })

  it('takes a relation lock, so the census requires it to carry a target', () => {
    expect(takesRelationLock('ALTER TABLE t SET (fillfactor = 70)')).toBe(true)
  })
})

describe('schemaLockTarget dropped indexes', () => {
  it('resolves a dropped index by name, with no table to name', () => {
    expect(schemaLockTarget('DROP INDEX IF EXISTS i')).toEqual({
      kind: 'index-by-name',
      name: 'i',
      skipWhen: 'absent'
    })
  })

  it('reads CONCURRENTLY as a modifier rather than the index name', () => {
    expect(schemaLockTarget('DROP INDEX CONCURRENTLY IF EXISTS i')?.name).toBe('i')
  })

  it('folds an unquoted name and keeps a quoted one, the way relname stores it', () => {
    expect(schemaLockTarget('DROP INDEX IF EXISTS MyIndex')?.name).toBe('myindex')
    expect(schemaLockTarget('DROP INDEX IF EXISTS "MyIndex"')?.name).toBe('MyIndex')
  })

  it('takes a relation lock, because the index is there on the boot that has to drop it', () => {
    expect(takesRelationLock('DROP INDEX IF EXISTS i')).toBe(true)
  })

  it('requires IF EXISTS, so a bare DROP fails the boot instead of running unchecked', () => {
    // Same contract as DROP CONSTRAINT: a bare DROP on a missing index is an error the server is
    // supposed to raise, and a pre-check that skipped it would swallow that.
    expect(() => requireSchemaLockTarget('DROP INDEX i')).toThrow(/unparsed_schema_lock_target/)
  })

  it('refuses a multi-index DROP rather than pre-checking only the first name', () => {
    // Skipping on one name would leave the other index in place for the life of the database.
    expect(() => requireSchemaLockTarget('DROP INDEX IF EXISTS a, b')).toThrow(
      /unparsed_schema_lock_target/
    )
  })

  it('derives the target through a leading deferrable marker', () => {
    // The real shape in relay's schema: the marker is a comment, so classification must see past
    // it or the statement would reach the server with no pre-check at all.
    const statement = '-- schema-deferrable: reason\nDROP INDEX IF EXISTS i'
    expect(sqlWithoutComments(statement)).toBe('DROP INDEX IF EXISTS i')
    expect(schemaLockTarget(statement)?.name).toBe('i')
  })
})

describe('schemaDeferrable', () => {
  it('reads the marker only from a leading comment, never from the SQL body', () => {
    // A name or a string containing the word must not make a statement deferrable.
    expect(schemaDeferrable('-- schema-deferrable: reason\nDROP INDEX IF EXISTS i')).toBe(true)
    expect(schemaDeferrable('DROP INDEX IF EXISTS schema_deferrable')).toBe(false)
    expect(schemaDeferrable("CREATE TABLE t (c TEXT DEFAULT 'schema-deferrable')")).toBe(false)
  })

  it('treats an unmarked statement as fatal on a lock timeout, which is the default', () => {
    expect(schemaDeferrable('DROP INDEX IF EXISTS i')).toBe(false)
    expect(schemaDeferrable('ALTER TABLE t SET (fillfactor = 70)')).toBe(false)
  })
})
