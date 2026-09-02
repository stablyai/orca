import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'

const TUI_STRUCTURED_PREFIX = 'tui.'

// Why: promoted [tui] settings are keyed by structured path (tui.<key>) so their
// baseline/update entries can never collide with a top-level key of the same name.
export function tuiStructuredKey(key: string): string {
  return `${TUI_STRUCTURED_PREFIX}${key}`
}

export function isTuiStructuredKey(structuredKey: string): boolean {
  return structuredKey.startsWith(TUI_STRUCTURED_PREFIX)
}

export function tuiKeyFromStructuredKey(structuredKey: string): string {
  return structuredKey.slice(TUI_STRUCTURED_PREFIX.length)
}

// Why: promoted updates arrive keyed by structured path; the preamble and [tui]
// regions are disjoint, so a mixed batch (e.g. /model + a status-line change)
// composes in one rewrite — top-level keys land in the preamble, tui.<key>
// entries wherever the [tui] placement rule puts them.
export function upsertPromotedSettingsInContent(
  content: string,
  updates: Map<string, string>
): string {
  const topLevelUpdates = new Map<string, string>()
  const tuiUpdates = new Map<string, string>()
  for (const [key, raw] of updates) {
    if (isTuiStructuredKey(key)) {
      tuiUpdates.set(tuiKeyFromStructuredKey(key), raw)
    } else {
      topLevelUpdates.set(key, raw)
    }
  }
  let result = content
  if (topLevelUpdates.size > 0) {
    result = upsertTopLevelSettingsInContent(result, topLevelUpdates)
  }
  if (tuiUpdates.size > 0) {
    result = upsertTuiSettingsInContent(result, tuiUpdates)
  }
  return result
}

export function upsertTopLevelSettingsInContent(
  content: string,
  updates: Map<string, string>
): string {
  const lines = content.split('\n')
  let state = createTomlLineScanState()
  let preambleEnd = lines.length
  const keyLineIndexes = new Map<string, number>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (isTomlStructuralLine(state)) {
      if (getTomlTableHeader(line)) {
        preambleEnd = index
        break
      }
      const parsed = parseTomlKeyPath(line)
      const key = parsed?.segments.length === 1 ? parsed.segments[0] : null
      if (parsed && line[parsed.end] === '=' && key && updates.has(key)) {
        keyLineIndexes.set(key, index)
      }
    }
    state = updateTomlLineScanState(state, line)
  }

  // Why: CRLF configs keep a trailing \r after the split; new lines must use
  // the file's existing endings or a Windows-owned config becomes mixed-EOL.
  const usesCrlf = content.includes('\r\n')
  const insertions: string[] = []
  for (const [key, raw] of updates) {
    const existingIndex = keyLineIndexes.get(key)
    const rendered = `${key} = ${raw}`
    if (existingIndex !== undefined) {
      lines[existingIndex] = lines[existingIndex]?.endsWith('\r') ? `${rendered}\r` : rendered
    } else {
      insertions.push(usesCrlf ? `${rendered}\r` : rendered)
    }
  }
  if (insertions.length > 0) {
    let insertAt = preambleEnd
    while (insertAt > 0 && (lines[insertAt - 1] ?? '').trim() === '') {
      insertAt -= 1
    }
    if (insertAt === preambleEnd && preambleEnd < lines.length) {
      insertions.push(usesCrlf ? '\r' : '')
    }
    lines.splice(insertAt, 0, ...insertions)
  }
  return joinPreservingTrailingNewline(lines, usesCrlf)
}

type TuiPlacementScan = {
  bareKeyIndexes: Map<string, number>
  dottedKeyIndexes: Map<string, number>
  hasBareTuiTable: boolean
  hasDottedTuiKey: boolean
  blocksNewTuiTable: boolean
  blockedAbsentKeys: Set<string>
  bareBodyInsertIndex: number
  lastDottedTuiIndex: number
}

/**
 * Upserts promoted `[tui]` keys (keyed by bare name) into the system config,
 * placing each per the design's total placement rule: replace an existing key
 * in place keeping its form; else insert bare into the first `[tui]` body; else
 * dotted in the preamble beside existing dotted `tui.*` keys; else create one
 * `[tui]` table at EOF for every key that reaches that branch. Rendering follows
 * the destination — bare inside a table, dotted in the preamble — so no `tui`
 * table is ever defined twice.
 */
export function upsertTuiSettingsInContent(content: string, updates: Map<string, string>): string {
  const lines = content.split('\n')
  const scan = scanTuiPlacement(lines, updates)
  const usesCrlf = content.includes('\r\n')
  const bareBodyInserts: string[] = []
  const dottedPreambleInserts: string[] = []
  const newTableKeys: string[] = []

  for (const [key, raw] of updates) {
    const dottedIndex = scan.dottedKeyIndexes.get(key)
    if (dottedIndex !== undefined) {
      lines[dottedIndex] = withTrailingCr(lines[dottedIndex]!, `${tuiStructuredKey(key)} = ${raw}`)
      continue
    }
    const bareIndex = scan.bareKeyIndexes.get(key)
    if (bareIndex !== undefined) {
      lines[bareIndex] = withTrailingCr(lines[bareIndex]!, `${key} = ${raw}`)
      continue
    }
    // Why: adding a scalar beside an existing tui.<key> descendant would turn valid TOML invalid.
    if (scan.blockedAbsentKeys.has(key)) {
      continue
    }
    if (scan.hasBareTuiTable) {
      bareBodyInserts.push(`${key} = ${raw}`)
    } else if (scan.hasDottedTuiKey) {
      dottedPreambleInserts.push(`${tuiStructuredKey(key)} = ${raw}`)
    } else if (!scan.blocksNewTuiTable) {
      // Why: inline/array tui definitions block this branch because adding a
      // plain [tui] beside either would make the config invalid.
      newTableKeys.push(`${key} = ${raw}`)
    }
  }

  // Why: the config shape routes every absent key to the same branch, so at most
  // one insert group is non-empty; still apply EOF→body→preamble so a splice
  // never shifts a lower index a later splice depends on.
  if (newTableKeys.length > 0) {
    appendNewTuiTable(lines, newTableKeys, usesCrlf)
  }
  if (bareBodyInserts.length > 0) {
    lines.splice(
      scan.bareBodyInsertIndex,
      0,
      ...bareBodyInserts.map((line) => withCrLine(line, usesCrlf))
    )
  }
  if (dottedPreambleInserts.length > 0) {
    lines.splice(
      scan.lastDottedTuiIndex + 1,
      0,
      ...dottedPreambleInserts.map((line) => withCrLine(line, usesCrlf))
    )
  }
  return joinPreservingTrailingNewline(lines, usesCrlf)
}

function scanTuiPlacement(lines: string[], updates: Map<string, string>): TuiPlacementScan {
  let state = createTomlLineScanState()
  let inPreamble = true
  let tuiTableSeen = false
  let tuiBodyActive = false
  let tuiBodyHeaderIndex = -1
  let tuiBodyEndIndex = -1
  let hasDottedTuiKey = false
  let blocksNewTuiTable = false
  let lastDottedTuiIndex = -1
  const bareKeyIndexes = new Map<string, number>()
  const dottedKeyIndexes = new Map<string, number>()
  const blockedAbsentKeys = new Set<string>()

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (isTomlStructuralLine(state)) {
      const header = getTomlTableHeader(line)
      if (header) {
        if (tuiBodyActive) {
          tuiBodyEndIndex = index
          tuiBodyActive = false
        }
        const table = parseTomlTableHeaderPath(header)
        if (
          table &&
          !table.isArray &&
          table.segments.length === 1 &&
          table.segments[0] === 'tui' &&
          !tuiTableSeen
        ) {
          tuiTableSeen = true
          tuiBodyActive = true
          tuiBodyHeaderIndex = index
        }
        // Why: a root [[tui]] is already an array, so appending [tui] would
        // redefine it and make an otherwise valid config unparseable.
        if (table?.isArray && table.segments.length === 1 && table.segments[0] === 'tui') {
          blocksNewTuiTable = true
        }
        const descendantKey =
          table?.segments[0] === 'tui' && table.segments.length > 1 ? table.segments[1] : null
        if (descendantKey && updates.has(descendantKey)) {
          blockedAbsentKeys.add(descendantKey)
        }
        inPreamble = false
        state = updateTomlLineScanState(state, line)
        continue
      }
      if (inPreamble) {
        // Why: any dotted `tui.*` key (allowlisted or not) already defines the
        // implicit tui table, so a new `[tui]` table at EOF would duplicate it.
        const parsed = parseTomlKeyPath(line)
        const isAssignment = parsed && line[parsed.end] === '='
        if (isAssignment && parsed.segments[0] === 'tui' && parsed.segments.length > 1) {
          hasDottedTuiKey = true
          lastDottedTuiIndex = index
          const promotedKey = parsed.segments.length === 2 ? parsed.segments[1] : null
          if (promotedKey && updates.has(promotedKey)) {
            dottedKeyIndexes.set(promotedKey, index)
          }
          const descendantKey = parsed.segments.length > 2 ? parsed.segments[1] : null
          if (descendantKey && updates.has(descendantKey)) {
            blockedAbsentKeys.add(descendantKey)
          }
        } else if (isAssignment && parsed.segments.length === 1 && parsed.segments[0] === 'tui') {
          blocksNewTuiTable = true
        }
      } else if (tuiBodyActive) {
        const parsed = parseTomlKeyPath(line)
        const key = parsed?.segments.length === 1 ? parsed.segments[0] : null
        if (parsed && line[parsed.end] === '=' && key && updates.has(key)) {
          bareKeyIndexes.set(key, index)
        }
        const descendantKey = parsed && parsed.segments.length > 1 ? parsed.segments[0] : null
        if (descendantKey && updates.has(descendantKey)) {
          blockedAbsentKeys.add(descendantKey)
        }
      }
    }
    state = updateTomlLineScanState(state, line)
  }
  if (tuiBodyActive) {
    tuiBodyEndIndex = lines.length
  }

  return {
    bareKeyIndexes,
    dottedKeyIndexes,
    hasBareTuiTable: tuiTableSeen,
    hasDottedTuiKey,
    blocksNewTuiTable,
    blockedAbsentKeys,
    bareBodyInsertIndex: computeBareBodyInsertIndex(lines, tuiBodyHeaderIndex, tuiBodyEndIndex),
    lastDottedTuiIndex
  }
}

// Why: TOML forbids adding bare keys to `[tui]` after a `[tui.*]` subtable opens,
// so absent keys land at the body's end — before trailing blanks and before the
// next header — which is the only valid spot.
function computeBareBodyInsertIndex(
  lines: string[],
  headerIndex: number,
  endIndex: number
): number {
  if (headerIndex === -1) {
    return -1
  }
  let insertAt = endIndex
  while (insertAt > headerIndex + 1 && (lines[insertAt - 1] ?? '').trim() === '') {
    insertAt -= 1
  }
  return insertAt
}

function appendNewTuiTable(lines: string[], keyRenders: string[], usesCrlf: boolean): void {
  let appendAt = lines.length
  while (appendAt > 0 && (lines[appendAt - 1] ?? '').trim() === '') {
    appendAt -= 1
  }
  // Why: separate the new table from prior content with a blank line, unless the
  // file was empty/blank, where a leading blank would be spurious.
  const block = appendAt > 0 ? ['', '[tui]', ...keyRenders] : ['[tui]', ...keyRenders]
  lines.splice(appendAt, 0, ...block.map((line) => withCrLine(line, usesCrlf)))
}

function withTrailingCr(originalLine: string, rendered: string): string {
  return originalLine.endsWith('\r') ? `${rendered}\r` : rendered
}

function withCrLine(rendered: string, usesCrlf: boolean): string {
  return usesCrlf ? `${rendered}\r` : rendered
}

// Why: a missing trailing newline is restored in the file's own EOL so a
// preamble-only or table-appended rewrite matches the source's newline behavior.
function joinPreservingTrailingNewline(lines: string[], usesCrlf: boolean): string {
  const result = lines.join('\n')
  if (result.endsWith('\n') || result.length === 0) {
    return result
  }
  return result.endsWith('\r') ? `${result}\n` : `${result}${usesCrlf ? '\r\n' : '\n'}`
}
