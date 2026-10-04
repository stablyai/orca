export type TomlTable = Record<string, unknown>

// Why: smol-toml's only declarations are ESM, which the CommonJS CLI build cannot
// import statically, so type just the two members used. A literal require() (not
// createRequire) lets the SSH relay's esbuild bundle inline it: relay hosts have no node_modules.
type SmolToml = {
  parse: (source: string, options: { integersAsBigInt: 'asNeeded' }) => TomlTable
  TomlError: abstract new (...args: never[]) => Error & { line: number; column: number }
}
const { parse, TomlError }: SmolToml = require('smol-toml')
export type TomlKeyPath = readonly string[]

export type CodexConfigTomlParse =
  | { ok: true; table: TomlTable }
  | { ok: false; message: string; line: number | null; column: number | null }

/** Parses Codex config.toml exactly as TOML 1.0 does, so duplicates in any spelling are errors. */
export function parseCodexConfigToml(content: string): CodexConfigTomlParse {
  const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  try {
    // Why: Codex reads integers as 64-bit, so values past 2^53 are valid config, not a parse error.
    return { ok: true, table: parse(source, { integersAsBigInt: 'asNeeded' }) }
  } catch (error) {
    if (error instanceof TomlError) {
      return {
        ok: false,
        message: error.message.split('\n')[0] ?? error.message,
        line: error.line,
        column: error.column
      }
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      line: null,
      column: null
    }
  }
}

export function isTomlTable(value: unknown): value is TomlTable {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    // Why: smol-toml's TomlDate extends Date, so this also excludes TOML datetimes.
    !(value instanceof Date)
  )
}

export function getTomlTable(value: unknown): TomlTable | null {
  return isTomlTable(value) ? value : null
}

export function readTomlValueAtPath(table: TomlTable, path: TomlKeyPath): unknown {
  let current: unknown = table
  for (const segment of path) {
    const next = getTomlTable(current)
    if (!next || !Object.hasOwn(next, segment)) {
      return undefined
    }
    current = next[segment]
  }
  return current
}

export function tomlValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && String(left) === String(right)
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => tomlValuesEqual(value, right[index]))
    )
  }
  const leftTable = getTomlTable(left)
  const rightTable = getTomlTable(right)
  if (!leftTable || !rightTable) {
    return false
  }
  const leftKeys = Object.keys(leftTable)
  return (
    leftKeys.length === Object.keys(rightTable).length &&
    leftKeys.every(
      (key) => Object.hasOwn(rightTable, key) && tomlValuesEqual(leftTable[key], rightTable[key])
    )
  )
}

/** Returns a copy without `paths`, dropping tables those removals left empty so a new parent table is not a change. */
export function omitTomlPaths(table: TomlTable, paths: readonly TomlKeyPath[]): TomlTable {
  const copy = cloneTomlTable(table)
  for (const path of paths) {
    omitTomlPath(copy, path)
  }
  return copy
}

function omitTomlPath(table: TomlTable, path: TomlKeyPath): void {
  const [head, ...rest] = path
  if (head === undefined || !Object.hasOwn(table, head)) {
    return
  }
  if (rest.length === 0) {
    delete table[head]
    return
  }
  const child = getTomlTable(table[head])
  if (!child) {
    return
  }
  omitTomlPath(child, rest)
  if (Object.keys(child).length === 0) {
    delete table[head]
  }
}

function cloneTomlTable(table: TomlTable): TomlTable {
  const copy: TomlTable = {}
  for (const [key, value] of Object.entries(table)) {
    const child = getTomlTable(value)
    copy[key] = child ? cloneTomlTable(child) : value
  }
  return copy
}
