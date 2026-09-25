import { observeAgentStateFile } from './codex-path-observation'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'
import { tuiStructuredKey } from './codex-config-settings-upsert'

// Why: only scalars the Codex TUI persists; each key here is written to the user's real ~/.codex, so grow deliberately.
export const PROMOTED_CODEX_SETTING_KEYS = [
  'model',
  'model_reasoning_effort',
  'approval_policy',
  'sandbox_mode'
] as const

// Why: the [tui] keys the Codex TUI's user-facing pickers persist (status line,
// terminal title, theme). Like the top-level list, every key here gets written
// into the user's real ~/.codex/config.toml on promotion — grow it deliberately.
export const PROMOTED_CODEX_TUI_SETTING_KEYS = [
  'status_line',
  'status_line_use_colors',
  'terminal_title',
  'theme'
] as const

// Why: promotion diffs and upserts operate on structured keys — top-level keys
// keep their bare name, [tui] keys are namespaced tui.<key> so their baseline
// entries cannot collide with a top-level key of the same name.
export const PROMOTED_STRUCTURED_KEYS: readonly string[] = [
  ...PROMOTED_CODEX_SETTING_KEYS,
  ...PROMOTED_CODEX_TUI_SETTING_KEYS.map(tuiStructuredKey)
]

function isPromotedTuiKey(key: string): boolean {
  return (PROMOTED_CODEX_TUI_SETTING_KEYS as readonly string[]).includes(key)
}

// Returns the structured tui key a scanned line's key represents, or null. In
// the preamble it recognizes the dotted `tui.<key>` form a user may hand-author;
// inside the first `[tui]` table body it recognizes the bare `<key>` form Codex
// writes. Both map to the same structured key so either config shape promotes.
function matchTuiStructuredKey(
  keyPath: string[],
  inPreamble: boolean,
  tuiBodyActive: boolean
): string | null {
  if (inPreamble) {
    const tuiKey = keyPath.length === 2 && keyPath[0] === 'tui' ? keyPath[1] : null
    return tuiKey && isPromotedTuiKey(tuiKey) ? tuiStructuredKey(tuiKey) : null
  }
  const tuiKey = keyPath.length === 1 ? keyPath[0] : null
  return tuiBodyActive && tuiKey && isPromotedTuiKey(tuiKey) ? tuiStructuredKey(tuiKey) : null
}

export type TopLevelSettingValue = {
  raw: string
  // Why: a multiline string/array value can't be replaced line-by-line, so it's excluded from promotion.
  multiline: boolean
}

function matchPromotedStructuredKey(
  line: string,
  inPreamble: boolean,
  tuiBodyActive: boolean
): { structuredKey: string; raw: string } | null {
  const parsed = parseTomlKeyPath(line)
  if (!parsed || line[parsed.end] !== '=') {
    return null
  }
  const raw = line.slice(parsed.end + 1).trim()
  const topLevelKey = parsed.segments.length === 1 ? parsed.segments[0] : null
  if (
    inPreamble &&
    topLevelKey &&
    (PROMOTED_CODEX_SETTING_KEYS as readonly string[]).includes(topLevelKey)
  ) {
    return { structuredKey: topLevelKey, raw }
  }
  const tuiKey = matchTuiStructuredKey(parsed.segments, inPreamble, tuiBodyActive)
  return tuiKey ? { structuredKey: tuiKey, raw } : null
}

// Why: top-level preamble scalars keep the historical behavior; [tui] keys are
// collected from the first bare [tui] table body or the dotted preamble form,
// keyed by structured path. Any table header (including [tui.*] subtables) ends
// the [tui] body, and [profiles.*]/other tables are still ignored.
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
  const lines = config.split('\n')
  let state = createTomlLineScanState()
  let inPreamble = true
  let tuiTableSeen = false
  let tuiBodyActive = false
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
        if (tuiBodyActive) {
          tuiTableSeen = true
        }
        inPreamble = false
        state = updateTomlLineScanState(state, line)
        continue
      }
      const matched = matchPromotedStructuredKey(line, inPreamble, tuiBodyActive)
      if (matched) {
        const nextState = updateTomlLineScanState(state, line)
        result.set(matched.structuredKey, {
          raw: matched.raw,
          multiline: !isTomlStructuralLine(nextState)
        })
        state = nextState
        continue
      }
    }
    state = updateTomlLineScanState(state, line)
  }
  return result
}
