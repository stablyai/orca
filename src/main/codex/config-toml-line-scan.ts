// Why: Orca edits Codex config.toml byte-preservingly (no TOML dependency), so
// every editor must agree on which lines sit inside multiline strings or
// arrays vs real TOML structure. Keep the line-scanner in one place to avoid
// drift.

export type TomlLineScanState = {
  basic: boolean
  literal: boolean
  arrayDepth: number
}

type TomlMultilineMode = 'basic' | 'literal' | null

export function createTomlLineScanState(): TomlLineScanState {
  return { basic: false, literal: false, arrayDepth: 0 }
}

// Why: lines inside multiline strings or unclosed arrays can look exactly like
// `[section]` headers or `key = value` pairs but are data, not structure.
export function isTomlStructuralLine(state: TomlLineScanState): boolean {
  return !state.basic && !state.literal && state.arrayDepth === 0
}

export function updateTomlLineScanState(state: TomlLineScanState, line: string): TomlLineScanState {
  let mode: TomlMultilineMode = state.basic ? 'basic' : state.literal ? 'literal' : null
  let arrayDepth = state.arrayDepth
  let index = 0
  while (index < line.length) {
    if (mode === 'basic') {
      if (line[index] === '\\') {
        index += 2
        continue
      }
      if (line.startsWith('"""', index)) {
        mode = null
        index += 3
        continue
      }
      index += 1
      continue
    }
    if (mode === 'literal') {
      if (line.startsWith("'''", index)) {
        mode = null
        index += 3
        continue
      }
      index += 1
      continue
    }

    const char = line[index]
    if (char === '#') {
      break
    }
    if (line.startsWith('"""', index)) {
      mode = 'basic'
      index += 3
      continue
    }
    if (line.startsWith("'''", index)) {
      mode = 'literal'
      index += 3
      continue
    }
    if (char === '"') {
      index = skipTomlBasicString(line, index + 1)
      continue
    }
    if (char === "'") {
      index = skipTomlLiteralString(line, index + 1)
      continue
    }
    // Why: table-header brackets balance within their line, so a depth that
    // stays positive across lines means a multiline array is still open.
    if (char === '[') {
      arrayDepth += 1
      index += 1
      continue
    }
    if (char === ']') {
      arrayDepth = Math.max(0, arrayDepth - 1)
      index += 1
      continue
    }
    index += 1
  }
  return { basic: mode === 'basic', literal: mode === 'literal', arrayDepth }
}

export function getTomlTableHeader(line: string): string | null {
  const match = /^(\s*\[\[?.+\]\]?\s*)(?:#.*)?$/.exec(line)
  return match?.[1] ?? null
}

function skipTomlBasicString(line: string, startIndex: number): number {
  let index = startIndex
  while (index < line.length) {
    const char = line[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '"') {
      return index + 1
    }
    index += 1
  }
  return index
}

function skipTomlLiteralString(line: string, startIndex: number): number {
  const endIndex = line.indexOf("'", startIndex)
  return endIndex === -1 ? line.length : endIndex + 1
}
