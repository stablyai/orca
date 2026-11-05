// Precheck catalog before boot DDL joins lock queue; table retains schema/quoting for to_regclass, name is the bare catalog identifier.
export type SchemaLockTarget =
  | {
      kind: 'index' | 'column' | 'constraint' | 'reloption'
      table: string
      name: string
      // Creates skip when present; IF EXISTS drops skip when absent.
      skipWhen: 'present' | 'absent'
    }
  // DROP INDEX has no table: resolve the name through search_path as PostgreSQL does.
  | { kind: 'index-by-name'; name: string; skipWhen: 'absent' }

// Reject keywords masquerading as absent identifiers (CONCURRENTLY, IF); genuine keyword names must be quoted to fail safely.
const NOT_KEYWORD = '(?!(?:CONCURRENTLY|IF|NOT|EXISTS|ON|ONLY)\\b)'
const IDENTIFIER = `"(?:[^"]|"")*"|${NOT_KEYWORD}[A-Za-z_][A-Za-z0-9_$]*`
const QUALIFIED = `((?:${IDENTIFIER})(?:\\.(?:${IDENTIFIER}))?)`

// Dollar-quoted bodies are opaque; exact matching tags keep inner $$ as text, and nonnumeric starts exclude $1 placeholders.
const DOLLAR_QUOTE = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y

function dollarQuoteEnd(sql: string, index: number): number | undefined {
  DOLLAR_QUOTE.lastIndex = index
  const opener = DOLLAR_QUOTE.exec(sql)?.[0]
  if (opener === undefined) return undefined
  const close = sql.indexOf(opener, index + opener.length)
  return close === -1 ? sql.length : close + opener.length
}

// Replace all comments with whitespace for classification/must-parse checks, including between keywords.
// Otherwise DDL can silently bypass prechecks; send original text to the server.
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
// Require IF EXISTS or a precheck skip would swallow the missing-constraint error; bare DROP fails boot.
const DROP_CONSTRAINT = new RegExp(
  `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${QUALIFIED}\\s+` +
    `DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+${QUALIFIED}`,
  'i'
)

// Require IF EXISTS to preserve missing-index errors; bare DROP fails boot instead of being prechecked away.
const DROP_INDEX = new RegExp(`^DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?IF\\s+EXISTS\\s+${QUALIFIED}\\s*$`, 'i')

// Compare one literal reloption as catalog name=value; multi-option statements cannot be safely skipped together.
const SET_RELOPTION = new RegExp(
  `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${QUALIFIED}\\s+` +
    `SET\\s+\\(\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*([A-Za-z0-9_.]+)\\s*\\)\\s*$`,
  'i'
)

// CREATE TABLE takes no lock on existing tables; ALTER/CREATE INDEX/DROP INDEX can.
// Include DROP while its index exists; catalog precheck supplies the no-lock steady state once absent.
const TAKES_RELATION_LOCK = /^(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|ALTER\s+TABLE)\b/i

export function takesRelationLock(statement: string): boolean {
  return TAKES_RELATION_LOCK.test(sqlWithoutComments(statement))
}

// Parse quoted dotted names whole; doubled quotes escape literal quotes.
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

// Fold unquoted names like PostgreSQL or written case misses catalog rows and rebuilds every boot.
function catalogName(written: string): string {
  const last = qualifiedParts(written).pop()
  if (!last) return written
  return last.quoted ? last.text : last.text.toLowerCase()
}

// Broader than target parsers so malformed lock-taking shapes fail rather than bypass precheck.
const MUST_PARSE = [
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
  /^ALTER\s+TABLE\b[\s\S]*\bADD\s+COLUMN\b/i,
  /^ALTER\s+TABLE\b[\s\S]*\bADD\s+CONSTRAINT\b/i,
  /^ALTER\s+TABLE\b[\s\S]*\bDROP\s+CONSTRAINT\b/i,
  /^ALTER\s+TABLE\b[\s\S]*\bSET\s+\(/i,
  /^DROP\s+INDEX\b/i
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
  const droppedIndex = DROP_INDEX.exec(sql)
  if (droppedIndex?.[1]) {
    return { kind: 'index-by-name', name: catalogName(droppedIndex[1]), skipWhen: 'absent' }
  }
  const option = SET_RELOPTION.exec(sql)
  if (option?.[1] && option[2] && option[3]) {
    // Fold option name but preserve value; changed name=value pairs must reapply.
    return {
      kind: 'reloption',
      table: option[1],
      name: `${catalogName(option[2])}=${option[3]}`,
      skipWhen: 'present'
    }
  }
  return undefined
}

const ALTER_TABLE = /^ALTER\s+TABLE\b/i

// Detect only top-level commas in comment-free SQL; types/defaults/CHECK/dollar bodies and ARRAY brackets can contain nested commas.
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

// Unparsed lock targets, including auto-named indexes, must fail boot rather than lock unchecked every time.
export function requireSchemaLockTarget(statement: string): SchemaLockTarget | undefined {
  const sql = sqlWithoutComments(statement)
  // One ALTER action per statement: skipping on first target would permanently lose later actions.
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
