import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  parseTomlSingleLineStringValue,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'

// Why: Codex persists plugin registration as two table families under a
// managed CODEX_HOME — `[marketplaces.<name>]` and `[plugins."<plugin>@<market>"]`.
// Reconciling them needs identity, not text, so the name is the parsed header
// segment: `[plugins."a@b"]` and `[plugins.'a@b']` are one registration.

export const CODEX_REGISTRATION_ROOTS = ['marketplaces', 'plugins'] as const

export type CodexRegistrationRoot = (typeof CODEX_REGISTRATION_ROOTS)[number]

export type CodexRegistrationField = {
  raw: string
  /** A value spanning lines cannot be replaced line-by-line, so it is never rewritten. */
  multiline: boolean
  lineIndex: number
}

export type CodexRegistrationEntry = {
  key: string
  root: CodexRegistrationRoot
  name: string
  /** Line range of the `[root.name]` table itself; -1 when only subtables exist. */
  ownerStart: number
  ownerEnd: number
  /** The registration's full text, including any `[root.name.*]` subtables. */
  block: string
  fields: ReadonlyMap<string, CodexRegistrationField>
}

export function getCodexRegistrationKey(root: CodexRegistrationRoot, name: string): string {
  return `${root}:${name}`
}

export function readCodexRegistrationEntries(config: string): Map<string, CodexRegistrationEntry> {
  const lines = config.split('\n')
  const headers = scanTomlTableHeaders(lines)
  const entries = new Map<string, CodexRegistrationEntry>()
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]!
    const root = header.segments[0]
    const name = header.segments[1]
    // Why: `[[marketplaces.x]]` is not a shape Codex writes; treating an array of
    // tables as one registration would key it by a name it may not own.
    if (header.isArray || !isCodexRegistrationRoot(root) || name === undefined) {
      continue
    }
    const end = headers[index + 1]?.index ?? lines.length
    const key = getCodexRegistrationKey(root, name)
    const isOwner = header.segments.length === 2
    const existing = entries.get(key)
    const block = lines.slice(header.index, end).join('\n').trimEnd()
    if (!existing) {
      entries.set(key, {
        key,
        root,
        name,
        ownerStart: isOwner ? header.index : -1,
        ownerEnd: isOwner ? end : -1,
        block,
        fields: isOwner ? readTomlTableFields(lines, header.index, end) : new Map()
      })
      continue
    }
    entries.set(key, {
      ...existing,
      // Why: a duplicate owner table is invalid TOML; the first one wins, exactly
      // as a TOML reader that rejects the second would have read the file.
      ownerStart: existing.ownerStart === -1 && isOwner ? header.index : existing.ownerStart,
      ownerEnd: existing.ownerStart === -1 && isOwner ? end : existing.ownerEnd,
      block: `${existing.block}\n\n${block}`,
      fields:
        existing.ownerStart === -1 && isOwner
          ? readTomlTableFields(lines, header.index, end)
          : existing.fields
    })
  }
  return entries
}

export function hasCodexRegistrationEntries(config: string): boolean {
  return readCodexRegistrationEntries(config).size > 0
}

/** Compares values by meaning, so quote style and a trailing comment never read as a change. */
export function normalizeCodexRegistrationValue(raw: string): string {
  const stripped = stripTomlTrailingComment(raw)
  const quoted = parseTomlSingleLineStringValue(stripped, 0)
  return quoted && quoted.end === stripped.length ? `string:${quoted.value}` : stripped
}

/**
 * Milliseconds for a marketplace refresh timestamp, or null when the value is not
 * an RFC 3339 / TOML date-time. Anything unparseable is malformed, never "older".
 */
export function parseCodexRegistrationTimestamp(raw: string): number | null {
  const stripped = stripTomlTrailingComment(raw)
  const quoted = parseTomlSingleLineStringValue(stripped, 0)
  const text = quoted && quoted.end === stripped.length ? quoted.value : stripped
  if (!/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/.test(text)) {
    return null
  }
  const parsed = Date.parse(text.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : null
}

function isCodexRegistrationRoot(value: string | undefined): value is CodexRegistrationRoot {
  return (CODEX_REGISTRATION_ROOTS as readonly string[]).includes(value ?? '')
}

type TomlTableHeaderMarker = {
  index: number
  segments: string[]
  isArray: boolean
}

// Why: an unparseable header still ends the previous table, so it is recorded
// with no segments rather than skipped — otherwise its lines would be attributed
// to the registration above it.
function scanTomlTableHeaders(lines: string[]): TomlTableHeaderMarker[] {
  const markers: TomlTableHeaderMarker[] = []
  let state = createTomlLineScanState()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (isTomlStructuralLine(state)) {
      const header = getTomlTableHeader(line)
      if (header) {
        const table = parseTomlTableHeaderPath(header)
        markers.push({
          index,
          segments: table?.segments ?? [],
          isArray: table?.isArray ?? false
        })
      }
    }
    state = updateTomlLineScanState(state, line)
  }
  return markers
}

function readTomlTableFields(
  lines: string[],
  headerIndex: number,
  end: number
): Map<string, CodexRegistrationField> {
  const fields = new Map<string, CodexRegistrationField>()
  let state = createTomlLineScanState()
  let index = headerIndex + 1
  while (index < end) {
    const line = lines[index] ?? ''
    const parsed = isTomlStructuralLine(state) ? parseTomlKeyPath(line) : null
    const name = parsed?.segments.length === 1 ? parsed.segments[0] : null
    if (!parsed || !name || line[parsed.end] !== '=') {
      state = updateTomlLineScanState(state, line)
      index += 1
      continue
    }
    let raw = line.slice(parsed.end + 1).trim()
    state = updateTomlLineScanState(state, line)
    let valueEnd = index + 1
    while (!isTomlStructuralLine(state) && valueEnd < end) {
      const continuation = lines[valueEnd] ?? ''
      raw += `\n${continuation.trim()}`
      state = updateTomlLineScanState(state, continuation)
      valueEnd += 1
    }
    if (!fields.has(name)) {
      fields.set(name, {
        raw,
        multiline: valueEnd > index + 1,
        lineIndex: index
      })
    }
    index = valueEnd
  }
  return fields
}

function stripTomlTrailingComment(raw: string): string {
  let index = 0
  while (index < raw.length) {
    const char = raw[index]
    if (char === '#') {
      return raw.slice(0, index).trim()
    }
    if (char === '"' || char === "'") {
      const quoted = parseTomlSingleLineStringValue(raw, index)
      if (!quoted) {
        return raw.trim()
      }
      index = quoted.end
      continue
    }
    index += 1
  }
  return raw.trim()
}
