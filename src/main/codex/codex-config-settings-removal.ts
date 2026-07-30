import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'
import { tuiStructuredKey } from './codex-config-settings-upsert'

export function removePromotedSettingsFromContent(
  content: string,
  removals: ReadonlySet<string>
): string {
  if (removals.size === 0) {
    return content
  }
  const lines = content.split('\n')
  const indexes: number[] = []
  let state = createTomlLineScanState()
  let inPreamble = true
  let tuiTableSeen = false
  let tuiBodyActive = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
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
        tuiTableSeen ||= tuiBodyActive
        inPreamble = false
        state = updateTomlLineScanState(state, line)
        continue
      }
      const parsed = parseTomlKeyPath(line)
      if (parsed && line[parsed.end] === '=') {
        const structuredKey = getStructuredKey(parsed.segments, inPreamble, tuiBodyActive)
        if (structuredKey && removals.has(structuredKey)) {
          indexes.push(index)
        }
      }
    }
    state = updateTomlLineScanState(state, line)
  }

  for (const index of indexes.toReversed()) {
    lines.splice(index, 1)
  }
  return lines.join('\n')
}

function getStructuredKey(
  segments: string[],
  inPreamble: boolean,
  tuiBodyActive: boolean
): string | null {
  if (inPreamble && segments.length === 1) {
    return segments[0] ?? null
  }
  if (inPreamble && segments.length === 2 && segments[0] === 'tui') {
    return segments[1] ? tuiStructuredKey(segments[1]) : null
  }
  if (tuiBodyActive && segments.length === 1) {
    return segments[0] ? tuiStructuredKey(segments[0]) : null
  }
  return null
}
