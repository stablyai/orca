import { observeAgentStateFile } from './codex-path-observation'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'
import { tableStructuredKey } from './codex-config-settings-upsert'
import { stripCodexDaemonOverride } from './codex-daemon-socket-path-guard'

// Why: only scalars the Codex TUI persists; each key here is written to the user's real ~/.codex, so grow deliberately.
export const PROMOTED_CODEX_SETTING_KEYS = [
  'model',
  'model_reasoning_effort',
  'approval_policy',
  'sandbox_mode'
] as const

// Why: table keys Codex persists from inside a pane — the TUI pickers' [tui]
// keys and the shared-server fix's [features] switch. Like the top-level list,
// every key here gets written into the user's real ~/.codex/config.toml.
export const PROMOTED_CODEX_TABLE_SETTING_KEYS = {
  tui: ['status_line', 'status_line_use_colors', 'terminal_title', 'theme'],
  features: ['daemon_auto_start']
} as const

// Why: promotion diffs and upserts operate on structured keys — top-level keys
// keep their bare name, table keys are namespaced <table>.<key> so their baseline
// entries cannot collide with a top-level key of the same name.
export const PROMOTED_STRUCTURED_KEYS: readonly string[] = [
  ...PROMOTED_CODEX_SETTING_KEYS,
  ...Object.entries(PROMOTED_CODEX_TABLE_SETTING_KEYS).flatMap(([table, keys]) =>
    keys.map((key) => tableStructuredKey(table, key))
  )
]

export type TopLevelSettingValue = {
  raw: string
  // Why: a multiline string/array value can't be replaced line-by-line, so it's excluded from promotion.
  multiline: boolean
}

export function readPromotedSettingValues(configPath: string): Map<string, TopLevelSettingValue> {
  // Why: an unreadable config held no settings only in the sense that we could
  // not read them. Returning an empty map says the user cleared every promoted
  // value, and the write below then acts on that.
  const observation = observeAgentStateFile(configPath)
  if (observation.kind === 'absent') {
    return new Map()
  }
  if (observation.kind === 'indeterminate') {
    throw observation.error
  }
  return readPromotedSettingValuesFromContent(observation.value)
}

export function readPromotedSettingValuesFromContent(
  config: string
): Map<string, TopLevelSettingValue> {
  const result = new Map<string, TopLevelSettingValue>()
  // Why: Orca's own daemon override is not a user setting, so it must never promote into ~/.codex.
  for (const setting of scanStructuredSettingLines(stripCodexDaemonOverride(config).split('\n'))) {
    if (PROMOTED_STRUCTURED_KEYS.includes(setting.structuredKey)) {
      result.set(setting.structuredKey, { raw: setting.raw, multiline: setting.multiline })
    }
  }
  return result
}

type StructuredSettingLine = TopLevelSettingValue & { index: number; structuredKey: string }

/**
 * Every single-line-scannable assignment keyed by structured path: bare preamble
 * keys, dotted `<table>.<key>` preamble keys, and bare keys in the first
 * `[<table>]` body. Subtables, array tables and later bodies are ignored.
 */
export function scanStructuredSettingLines(lines: readonly string[]): StructuredSettingLine[] {
  const settings: StructuredSettingLine[] = []
  let state = createTomlLineScanState()
  let inPreamble = true
  let bodyTable: string | null = null
  const seenTables = new Set<string>()
  for (const [index, line] of lines.entries()) {
    const structural = isTomlStructuralLine(state)
    state = updateTomlLineScanState(state, line)
    const header = structural ? getTomlTableHeader(line) : null
    if (header) {
      const table = parseTomlTableHeaderPath(header)
      const name = table && !table.isArray && table.segments.length === 1 ? table.segments[0] : null
      bodyTable = name && !seenTables.has(name) ? name : null
      if (name) {
        seenTables.add(name)
      }
      inPreamble = false
      continue
    }
    const parsed = structural ? parseTomlKeyPath(line) : null
    if (!parsed || line[parsed.end] !== '=') {
      continue
    }
    const structuredKey = getStructuredKey(parsed.segments, inPreamble, bodyTable)
    if (structuredKey !== null) {
      settings.push({
        index,
        structuredKey,
        raw: line.slice(parsed.end + 1).trim(),
        multiline: !isTomlStructuralLine(state)
      })
    }
  }
  return settings
}

function getStructuredKey(
  segments: readonly string[],
  inPreamble: boolean,
  bodyTable: string | null
): string | null {
  const [first, second, ...rest] = segments
  // Why: a quoted `"tui.theme"` is one key, not the [tui] table's theme.
  if (first === undefined || rest.length > 0 || segments.some((segment) => segment.includes('.'))) {
    return null
  }
  if (!inPreamble) {
    return bodyTable !== null && second === undefined ? tableStructuredKey(bodyTable, first) : null
  }
  return second === undefined ? first : tableStructuredKey(first, second)
}
