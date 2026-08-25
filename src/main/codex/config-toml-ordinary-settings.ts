import { isOrcaRewrittenCodexPreambleKey } from './codex-config-path-reference-rewrite'
import { tuiStructuredKey } from './codex-config-settings-upsert'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'

export type OrdinaryCodexSettingValue = {
  raw: string
  // Why: a multiline string/array value can't be replaced line-by-line, so it's excluded from promotion.
  multiline: boolean
  unsupported?: boolean
}

// Why: these are user preferences the Codex TUI persists. Pre-registering them
// in the baseline makes the first in-Codex change promote into ~/.codex instead
// of sitting as a runtime-local conflict. Other ordinary keys carry through the
// remirror without that write-through.
export const PROMOTED_CODEX_SETTING_KEYS = [
  'model',
  'model_reasoning_effort',
  'approval_policy',
  'sandbox_mode'
] as const

export const PROMOTED_CODEX_TUI_SETTING_KEYS = [
  'status_line',
  'status_line_use_colors',
  'terminal_title',
  'theme'
] as const

export const PROMOTED_STRUCTURED_KEYS: readonly string[] = [
  ...PROMOTED_CODEX_SETTING_KEYS,
  ...PROMOTED_CODEX_TUI_SETTING_KEYS.map(tuiStructuredKey)
]

export function parseOrdinaryCodexSettingValues(
  content: string
): Map<string, OrdinaryCodexSettingValue> {
  const result = new Map<string, OrdinaryCodexSettingValue>()
  const lines = content.split('\n')
  let state = createTomlLineScanState()
  let inPreamble = true
  let tuiTableSeen = false
  let tuiBodyActive = false
  let genericTuiBodyActive = false
  const blockedKeys = new Set<string>()
  for (const line of lines) {
    if (isTomlStructuralLine(state)) {
      const header = getTomlTableHeader(line)
      if (header) {
        const table = parseTomlTableHeaderPath(header)
        tuiBodyActive =
          table !== null &&
          !table.isArray &&
          table.segments.length === 1 &&
          table.segments[0] === 'tui' &&
          !tuiTableSeen
        genericTuiBodyActive = tuiBodyActive && header.trim() === '[tui]'
        if (tuiBodyActive) {
          tuiTableSeen = true
        }
        blockTableNamespace(table, blockedKeys)
        inPreamble = false
        state = updateTomlLineScanState(state, line)
        continue
      }
      blockDottedNamespace(line, inPreamble, tuiBodyActive, blockedKeys)
      blockTuiScalarNamespace(line, inPreamble, blockedKeys)
      const matched = matchOrdinaryStructuredKey(
        line,
        inPreamble,
        tuiBodyActive,
        genericTuiBodyActive
      )
      if (matched) {
        const nextState = updateTomlLineScanState(state, line)
        result.set(matched.structuredKey, {
          raw: matched.raw,
          multiline: !isTomlStructuralLine(nextState),
          unsupported: containsInlineTable(matched.raw)
        })
        state = nextState
        continue
      }
    }
    state = updateTomlLineScanState(state, line)
  }
  for (const key of blockedKeys) {
    result.set(key, { raw: '', multiline: false, unsupported: true })
  }
  return result
}

export function collectOrdinaryCodexSettingKeys(
  runtimeValues: ReadonlyMap<string, OrdinaryCodexSettingValue>,
  systemValues: ReadonlyMap<string, OrdinaryCodexSettingValue>,
  trackedKeys: Iterable<string>
): string[] {
  return [
    ...new Set([
      ...PROMOTED_STRUCTURED_KEYS,
      ...runtimeValues.keys(),
      ...systemValues.keys(),
      ...trackedKeys
    ])
  ]
}

function matchOrdinaryStructuredKey(
  line: string,
  inPreamble: boolean,
  tuiBodyActive: boolean,
  genericTuiBodyActive: boolean
): { structuredKey: string; raw: string } | null {
  const parsed = parseTomlKeyPath(line)
  if (!parsed || line[parsed.end] !== '=') {
    return null
  }
  const raw = line.slice(parsed.end + 1).trim()
  const keySource = line.slice(0, parsed.end).trim()
  const topLevelKey = parsed.segments.length === 1 ? parsed.segments[0] : null
  // Why: `tui = { ... }` already defines the tui table; scanning it as a scalar
  // would strand a conflict against a `[tui]` body the upsert cannot place.
  if (
    inPreamble &&
    topLevelKey &&
    topLevelKey !== 'tui' &&
    (isPromotedStructuredKey(topLevelKey) || isBareTomlKey(keySource)) &&
    !isOrcaRewrittenCodexPreambleKey(topLevelKey)
  ) {
    return { structuredKey: topLevelKey, raw }
  }
  const tuiKey = matchTuiStructuredKey(
    parsed.segments,
    keySource,
    inPreamble,
    tuiBodyActive,
    genericTuiBodyActive
  )
  return tuiKey ? { structuredKey: tuiKey, raw } : null
}

function matchTuiStructuredKey(
  keyPath: string[],
  keySource: string,
  inPreamble: boolean,
  tuiBodyActive: boolean,
  genericTuiBodyActive: boolean
): string | null {
  if (inPreamble) {
    const tuiKey = keyPath.length === 2 && keyPath[0] === 'tui' ? keyPath[1] : null
    if (!tuiKey) {
      return null
    }
    const structuredKey = tuiStructuredKey(tuiKey)
    return isPromotedStructuredKey(structuredKey) || isBareDottedTuiKey(keySource)
      ? structuredKey
      : null
  }
  const tuiKey = keyPath.length === 1 ? keyPath[0] : null
  if (!tuiBodyActive || !tuiKey) {
    return null
  }
  const structuredKey = tuiStructuredKey(tuiKey)
  return isPromotedStructuredKey(structuredKey) ||
    (genericTuiBodyActive && isBareTomlKey(keySource))
    ? structuredKey
    : null
}

export function isPromotedStructuredKey(key: string): boolean {
  return PROMOTED_STRUCTURED_KEYS.includes(key)
}

export function isOrdinarySettingBlocked(
  values: ReadonlyMap<string, OrdinaryCodexSettingValue>,
  key: string
): boolean {
  return (
    !!values.get(key)?.unsupported || (key.startsWith('tui.') && !!values.get('tui')?.unsupported)
  )
}

function isBareTomlKey(source: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(source)
}

function isBareDottedTuiKey(source: string): boolean {
  return /^tui\s*\.\s*[A-Za-z0-9_-]+$/.test(source)
}

function blockTableNamespace(
  table: ReturnType<typeof parseTomlTableHeaderPath>,
  blockedKeys: Set<string>
): void {
  if (!table || table.segments.length === 0) {
    return
  }
  if (table.segments[0] === 'tui') {
    if (table.segments.length > 1) {
      const key = table.segments[1]
      if (key) {
        blockedKeys.add(tuiStructuredKey(key))
      }
    }
    return
  }
  const root = table.segments[0]
  if (root) {
    blockedKeys.add(root)
  }
}

function blockDottedNamespace(
  line: string,
  inPreamble: boolean,
  tuiBodyActive: boolean,
  blockedKeys: Set<string>
): void {
  const parsed = parseTomlKeyPath(line)
  if (!parsed || line[parsed.end] !== '=') {
    return
  }
  if (inPreamble && parsed.segments[0] === 'tui' && parsed.segments.length > 2) {
    const key = parsed.segments[1]
    if (key) {
      blockedKeys.add(tuiStructuredKey(key))
    }
  } else if (inPreamble && parsed.segments.length > 1 && parsed.segments[0] !== 'tui') {
    const root = parsed.segments[0]
    if (root) {
      blockedKeys.add(root)
    }
  } else if (tuiBodyActive && parsed.segments.length > 1) {
    const key = parsed.segments[0]
    if (key) {
      blockedKeys.add(tuiStructuredKey(key))
    }
  }
}

function blockTuiScalarNamespace(
  line: string,
  inPreamble: boolean,
  blockedKeys: Set<string>
): void {
  if (!inPreamble) {
    return
  }
  const parsed = parseTomlKeyPath(line)
  if (parsed?.segments.length === 1 && parsed.segments[0] === 'tui' && line[parsed.end] === '=') {
    blockedKeys.add('tui')
  }
}

function containsInlineTable(raw: string): boolean {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (quote === '"' && char === '\\') {
      index += 1
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
    } else if (char === '#') {
      return false
    } else if (char === '{') {
      return true
    }
  }
  return false
}
