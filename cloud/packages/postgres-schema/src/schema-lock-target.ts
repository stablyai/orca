// The object a boot-time DDL statement locks on Postgres, so the catalog can be asked whether it
// already exists before the statement joins the lock queue. `table` is kept exactly as the
// statement wrote it, schema qualification and quoting included, because it is fed to
// `to_regclass`; `name` is the bare identifier the catalog stores in `relname`/`attname`.
export type SchemaLockTarget = {
  kind: 'index' | 'column' | 'constraint'
  table: string
  name: string
  // The catalog answer that means this statement has nothing left to do. Creating statements skip
  // on present; `DROP CONSTRAINT IF EXISTS` is the inverse, because nothing to drop is done.
  skipWhen: 'present' | 'absent'
}

// Keywords that sit in an identifier position when the optional clause before them is absent.
// Without this, `CREATE UNIQUE INDEX CONCURRENTLY ON t(c)` reads CONCURRENTLY as the index name and
// `ADD COLUMN IF NOT EXISTS` with no column reads IF as the column: a silently wrong target, which
// is worse than no target. Excluding them makes both throw instead. A column genuinely named `if`
// has to be quoted to be derivable, which is the safe direction to fail in.
const NOT_KEYWORD = '(?!(?:CONCURRENTLY|IF|NOT|EXISTS|ON|ONLY)\\b)'
const IDENTIFIER = `"(?:[^"]|"")*"|${NOT_KEYWORD}[A-Za-z_][A-Za-z0-9_$]*`
const QUALIFIED = `((?:${IDENTIFIER})(?:\\.(?:${IDENTIFIER}))?)`

// `$$...$$` and `$tag$...$tag$` are opaque: a comment marker, comma, parenthesis or bracket inside
// one is text. The closing delimiter must match the opening tag exactly, so an inner `$$` inside a
// `$tag$` body is more text rather than the end. The tag cannot start with a digit, which is what
// keeps a `$1` placeholder from reading as an opener.
const DOLLAR_QUOTE = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y

function dollarQuoteEnd(sql: string, index: number): number | undefined {
  DOLLAR_QUOTE.lastIndex = index
  const opener = DOLLAR_QUOTE.exec(sql)?.[0]
  if (opener === undefined) return undefined
  const close = sql.indexOf(opener, index + opener.length)
  return close === -1 ? sql.length : close + opener.length
}

// Every comment, not only the block a ';'-split schema glues above a statement. A comment between
// two keywords (`ADD /* note */ COLUMN`) is invisible to the classification regexes AND to the
// must-parse shapes, so it used to yield no target and no throw: the statement ran with no
// pre-check at all, which is the one direction this must never fail in. Postgres treats a comment
// as whitespace, so each becomes a single space. Only classification reads this; the server is
// always sent the original text.
export function sqlWithoutComments(statement: string): string {
  let stripped = ''
  let quote: string | undefined
  for (let index = 0; index < statement.length; index += 1) {
    const character = statement[index]!
    if (quote !== undefined) {
      stripped += character
      if (character !== quote) continue
      if (statement[index + 1] === quote) {
        stripped += quote
        index += 1
      } else quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      stripped += character
      continue
    }
    if (character === '$') {
      const end = dollarQuoteEnd(statement, index)
      if (end !== undefined) {
        stripped += statement.slice(index, end)
        index = end - 1
        continue
      }
    }
    if (character === '-' && statement[index + 1] === '-') {
      const newline = statement.indexOf('\n', index)
      index = newline === -1 ? statement.length : newline
      stripped += ' '
      continue
    }
    if (character === '/' && statement[index + 1] === '*') {
      // Postgres nests block comments, so a depth counter is what closes the right one.
      let depth = 1
      index += 2
      while (index < statement.length && depth > 0) {
        if (statement[index] === '/' && statement[index + 1] === '*') {
          depth += 1
          index += 2
        } else if (statement[index] === '*' && statement[index + 1] === '/') {
          depth -= 1
          index += 2
        } else index += 1
      }
      index -= 1
      stripped += ' '
      continue
    }
    stripped += character
  }
  return stripped.trim()
}

const CREATE_INDEX = new RegExp(
  `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?` +
    `${QUALIFIED}\\s+ON\\s+(?:ONLY\\s+)?${QUALIFIED}`,
  'i'
)
const ADD_COLUMN = new RegExp(
  `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${QUALIFIED}\\s+` +
    `ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUALIFIED}`,
  'i'
)
const ADD_CONSTRAINT = new RegExp(
  `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${QUALIFIED}\\s+` +
    `ADD\\s+CONSTRAINT\\s+${QUALIFIED}`,
  'i'
)
// `IF EXISTS` is required, not optional. A bare `DROP CONSTRAINT` on a missing constraint is an
// error the server is supposed to raise, and skipping it would swallow that. Without a target the
// statement throws at boot instead, which tells the author to write `IF EXISTS`.
const DROP_CONSTRAINT = new RegExp(
  `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${QUALIFIED}\\s+` +
    `DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+${QUALIFIED}`,
  'i'
)

// Every statement shape that takes a relation lock before Postgres evaluates its existence test.
// `CREATE TABLE IF NOT EXISTS` is absent on purpose: it resolves a name against the schema and
// takes no lock on an existing table.
const TAKES_RELATION_LOCK = /^(?:CREATE\s+(?:UNIQUE\s+)?INDEX|ALTER\s+TABLE)\b/i

export function takesRelationLock(statement: string): boolean {
  return TAKES_RELATION_LOCK.test(sqlWithoutComments(statement))
}

// Splitting on '.' is not enough: `"a.b"` is one identifier containing a dot, not two parts. Each
// part is read quote-aware, with a doubled quote unescaped to one.
function qualifiedParts(written: string): { text: string; quoted: boolean }[] {
  const parts: { text: string; quoted: boolean }[] = []
  let text = ''
  let quoted = false
  let wasQuoted = false
  for (let index = 0; index < written.length; index += 1) {
    const character = written[index]!
    if (quoted) {
      if (character !== '"') {
        text += character
        continue
      }
      if (written[index + 1] === '"') {
        text += '"'
        index += 1
      } else quoted = false
      continue
    }
    if (character === '"') {
      quoted = true
      wasQuoted = true
    } else if (character === '.') {
      parts.push({ text, quoted: wasQuoted })
      text = ''
      wasQuoted = false
    } else text += character
  }
  parts.push({ text, quoted: wasQuoted })
  return parts
}

// Postgres folds an unquoted identifier to lower case before storing it, so `Foo` is `foo` in
// relname, attname and conname. Comparing the written case would miss the row and rebuild the
// object on every boot.
function catalogName(written: string): string {
  const last = qualifiedParts(written).pop()
  if (!last) return written
  return last.quoted ? last.text : last.text.toLowerCase()
}

// Shapes whose lock target the pre-check must be able to derive. Deliberately looser than the
// regexes that parse them, so a statement that reads as one of these but does not parse is caught
// rather than falling through to the lock path.
const MUST_PARSE = [
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
  /^ALTER\s+TABLE\b[\s\S]*\bADD\s+COLUMN\b/i,
  /^ALTER\s+TABLE\b[\s\S]*\bADD\s+CONSTRAINT\b/i,
  /^ALTER\s+TABLE\b[\s\S]*\bDROP\s+CONSTRAINT\b/i
]

// Derived from the statement itself so a renamed index cannot drift away from its pre-check.
export function schemaLockTarget(statement: string): SchemaLockTarget | undefined {
  const sql = sqlWithoutComments(statement)
  const index = CREATE_INDEX.exec(sql)
  if (index?.[1] && index[2]) {
    return { kind: 'index', table: index[2], name: catalogName(index[1]), skipWhen: 'present' }
  }
  const column = ADD_COLUMN.exec(sql)
  if (column?.[1] && column[2]) {
    return { kind: 'column', table: column[1], name: catalogName(column[2]), skipWhen: 'present' }
  }
  const added = ADD_CONSTRAINT.exec(sql)
  if (added?.[1] && added[2]) {
    return {
      kind: 'constraint',
      table: added[1],
      name: catalogName(added[2]),
      skipWhen: 'present'
    }
  }
  const dropped = DROP_CONSTRAINT.exec(sql)
  if (dropped?.[1] && dropped[2]) {
    return {
      kind: 'constraint',
      table: dropped[1],
      name: catalogName(dropped[2]),
      skipWhen: 'absent'
    }
  }
  return undefined
}

const ALTER_TABLE = /^ALTER\s+TABLE\b/i

// A comma that separates ALTER TABLE subcommands rather than sitting inside a type, a default, a
// CHECK body or a dollar-quoted body. Takes comment-free SQL. Square brackets count as depth too,
// or an array type or `DEFAULT ARRAY[1, 2]` reads as a second subcommand and fails the boot.
function hasTopLevelComma(sql: string): boolean {
  let depth = 0
  let quote: string | undefined
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]
    if (quote !== undefined) {
      if (character !== quote) continue
      if (sql[index + 1] === quote) index += 1
      else quote = undefined
      continue
    }
    if (character === '$') {
      const end = dollarQuoteEnd(sql, index)
      if (end !== undefined) {
        index = end - 1
        continue
      }
    }
    if (character === "'" || character === '"') quote = character
    else if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth -= 1
    else if (character === ',' && depth === 0) return true
  }
  return false
}

// An index or column statement whose target cannot be read is the dangerous case: it would be sent
// unchecked and take the lock the pre-check exists to avoid, silently and on every boot. An
// auto-named `CREATE INDEX ON t(c)` lands here too, because nothing in the text says what the
// catalog will call it. Fail the boot with the statement instead.
export function requireSchemaLockTarget(statement: string): SchemaLockTarget | undefined {
  const sql = sqlWithoutComments(statement)
  // A multi-action ALTER TABLE parses to its FIRST subcommand's target only, so skipping on that
  // one object would silently drop every later action for the life of the database. One action per
  // statement, or no pre-check is possible.
  if (ALTER_TABLE.test(sql) && hasTopLevelComma(sql)) {
    throw new Error(`unparsed_schema_lock_target: ${sql}`)
  }
  const target = schemaLockTarget(statement)
  if (target) return target
  if (MUST_PARSE.some((shape) => shape.test(sql))) {
    throw new Error(`unparsed_schema_lock_target: ${sql}`)
  }
  return undefined
}
