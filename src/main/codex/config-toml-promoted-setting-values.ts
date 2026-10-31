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

// Allowlist settings written back into the user's canonical Codex config.
export const PROMOTED_CODEX_SETTING_KEYS = [
  'model',
  'model_reasoning_effort',
  'approval_policy',
  'sandbox_mode'
] as const

export const PROMOTED_CODEX_TABLE_SETTING_KEYS = {
  tui: ['status_line', 'status_line_use_colors', 'terminal_title', 'theme'],
  features: ['daemon_auto_start']
} as const

// Namespace table keys so baseline entries cannot collide with top-level settings.
export const PROMOTED_STRUCTURED_KEYS: readonly string[] = [
  ...PROMOTED_CODEX_SETTING_KEYS,
  ...Object.entries(PROMOTED_CODEX_TABLE_SETTING_KEYS).flatMap(([table, keys]) =>
    keys.map((key) => tableStructuredKey(table, key))
  )
]

export type TopLevelSettingValue = {
  raw: string
  // Multiline values cannot be promoted by line edits.
  multiline: boolean
}

export function readPromotedSettingValues(configPath: string): Map<string, TopLevelSettingValue> {
  // Unreadable settings must not be mistaken for user deletions.
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
  // Keep Orca's runtime-only daemon override out of the canonical config.
  for (const setting of scanStructuredSettingLines(stripCodexDaemonOverride(config).split('\n'))) {
    if (PROMOTED_STRUCTURED_KEYS.includes(setting.structuredKey)) {
      result.set(setting.structuredKey, { raw: setting.raw, multiline: setting.multiline })
    }
  }
  return result
}

type StructuredSettingLine = TopLevelSettingValue & { index: number; structuredKey: string }

/** Scan preamble and first-level table assignments; ignore subtables, array tables and repeated bodies. */
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
  // A quoted "tui.theme" is one literal key, not the theme entry in [tui].
  if (first === undefined || rest.length > 0 || segments.some((segment) => segment.includes('.'))) {
    return null
  }
  if (!inPreamble) {
    return bodyTable !== null && second === undefined ? tableStructuredKey(bodyTable, first) : null
  }
  return second === undefined ? first : tableStructuredKey(first, second)
}
