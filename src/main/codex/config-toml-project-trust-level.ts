import { parseTomlKeyPath } from './config-toml-key-path'
import {
  createTomlLineScanState,
  isTomlStructuralLine,
  parseTomlSingleLineStringValue,
  updateTomlLineScanState
} from './config-toml-line-scan'

export type ProjectTrustLevelEntry = {
  /** Null when the value is not a recognised trust level; the key still exists. */
  value: 'trusted' | 'untrusted' | null
  /** Offsets of the line within the scanned text, excluding any trailing `\r`. */
  start: number
  end: number
  line: string
}

// Why (#22592): Codex writes `"trust_level" = …`; decode the key instead of matching bare text.
export function findProjectTrustLevelEntries(text: string): ProjectTrustLevelEntry[] {
  const entries: ProjectTrustLevelEntry[] = []
  let cursor = 0
  let scanState = createTomlLineScanState()
  while (cursor <= text.length) {
    const newlineIndex = text.indexOf('\n', cursor)
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex
    const line = text.slice(cursor, lineEnd).replace(/\r$/, '')
    if (isTomlStructuralLine(scanState)) {
      const key = parseTomlKeyPath(line)
      if (key && key.segments.length === 1 && key.segments[0] === 'trust_level') {
        if (line[key.end] === '=') {
          entries.push({
            value: parseTrustLevelValue(line, key.end + 1),
            start: cursor,
            end: cursor + line.length,
            line
          })
        }
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
    if (newlineIndex === -1) {
      break
    }
    cursor = newlineIndex + 1
  }
  return entries
}

function parseTrustLevelValue(line: string, offset: number): 'trusted' | 'untrusted' | null {
  const parsed = parseTomlSingleLineStringValue(line, offset)
  if (!parsed || !/^[ \t]*(?:#.*)?$/.test(line.slice(parsed.end))) {
    return null
  }
  return parsed.value === 'trusted' || parsed.value === 'untrusted' ? parsed.value : null
}
