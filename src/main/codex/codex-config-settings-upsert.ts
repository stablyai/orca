import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  joinPreservingTrailingNewline,
  updateTomlLineScanState,
  withCrLine,
  withTrailingCr
} from './config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'

// Qualify table keys so baseline/update entries cannot collide with top-level settings.
export function tableStructuredKey(table: string, key: string): string {
  return `${table}.${key}`
}

export function upsertPromotedSettingsInContent(
  content: string,
  updates: Map<string, string>
): string {
  const topLevelUpdates = new Map<string, string>()
  const tableUpdates = new Map<string, Map<string, string>>()
  for (const [structuredKey, raw] of updates) {
    const dot = structuredKey.indexOf('.')
    if (dot === -1) {
      topLevelUpdates.set(structuredKey, raw)
      continue
    }
    const table = structuredKey.slice(0, dot)
    const keys = tableUpdates.get(table) ?? new Map<string, string>()
    tableUpdates.set(table, keys.set(structuredKey.slice(dot + 1), raw))
  }
  let result =
    topLevelUpdates.size > 0 ? upsertTopLevelSettingsInContent(content, topLevelUpdates) : content
  for (const [table, keys] of tableUpdates) {
    result = upsertTableSettingsInContent(result, table, keys)
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

  // Preserve CRLF on inserted lines to avoid mixed endings in Windows configs.
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

type TablePlacementScan = {
  bareKeyIndexes: Map<string, number>
  dottedKeyIndexes: Map<string, number>
  hasBareTable: boolean
  hasDottedKey: boolean
  blocksNewTable: boolean
  blockedAbsentKeys: Set<string>
  bareBodyInsertIndex: number
  lastDottedKeyIndex: number
}

/** Preserve existing key form; otherwise use the bare table, dotted preamble, then a new EOF table. */
export function upsertTableSettingsInContent(
  content: string,
  table: string,
  updates: Map<string, string>
): string {
  const lines = content.split('\n')
  const scan = scanTablePlacement(lines, table, updates)
  const usesCrlf = content.includes('\r\n')
  const bareBodyInserts: string[] = []
  const dottedPreambleInserts: string[] = []
  const newTableKeys: string[] = []

  for (const [key, raw] of updates) {
    const dottedIndex = scan.dottedKeyIndexes.get(key)
    if (dottedIndex !== undefined) {
      lines[dottedIndex] = withTrailingCr(lines[dottedIndex]!, `${table}.${key} = ${raw}`)
      continue
    }
    const bareIndex = scan.bareKeyIndexes.get(key)
    if (bareIndex !== undefined) {
      lines[bareIndex] = withTrailingCr(lines[bareIndex]!, `${key} = ${raw}`)
      continue
    }
    // A scalar cannot replace a key already defined as a table by its descendants.
    if (scan.blockedAbsentKeys.has(key)) {
      continue
    }
    if (scan.hasBareTable) {
      bareBodyInserts.push(`${key} = ${raw}`)
    } else if (scan.hasDottedKey) {
      dottedPreambleInserts.push(`${table}.${key} = ${raw}`)
    } else if (!scan.blocksNewTable) {
      // Inline/array definitions cannot coexist with a new plain table.
      newTableKeys.push(`${key} = ${raw}`)
    }
  }

  // Apply splices from EOF backward so earlier indices remain valid.
  if (newTableKeys.length > 0) {
    appendNewTable(lines, table, newTableKeys, usesCrlf)
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
      scan.lastDottedKeyIndex + 1,
      0,
      ...dottedPreambleInserts.map((line) => withCrLine(line, usesCrlf))
    )
  }
  return joinPreservingTrailingNewline(lines, usesCrlf)
}

function scanTablePlacement(
  lines: string[],
  tableName: string,
  updates: Map<string, string>
): TablePlacementScan {
  let state = createTomlLineScanState()
  let inPreamble = true
  let tableSeen = false
  let tableBodyActive = false
  let tableBodyHeaderIndex = -1
  let tableBodyEndIndex = -1
  let hasDottedKey = false
  let blocksNewTable = false
  let lastDottedKeyIndex = -1
  const bareKeyIndexes = new Map<string, number>()
  const dottedKeyIndexes = new Map<string, number>()
  const blockedAbsentKeys = new Set<string>()

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (isTomlStructuralLine(state)) {
      const header = getTomlTableHeader(line)
      if (header) {
        if (tableBodyActive) {
          tableBodyEndIndex = index
          tableBodyActive = false
        }
        const table = parseTomlTableHeaderPath(header)
        if (
          table &&
          !table.isArray &&
          table.segments.length === 1 &&
          table.segments[0] === tableName &&
          !tableSeen
        ) {
          tableSeen = true
          tableBodyActive = true
          tableBodyHeaderIndex = index
        }
        // A plain table would redefine the existing array table.
        if (table?.isArray && table.segments.length === 1 && table.segments[0] === tableName) {
          blocksNewTable = true
        }
        const descendantKey =
          table?.segments[0] === tableName && table.segments.length > 1 ? table.segments[1] : null
        if (descendantKey && updates.has(descendantKey)) {
          blockedAbsentKeys.add(descendantKey)
        }
        inPreamble = false
        state = updateTomlLineScanState(state, line)
        continue
      }
      if (inPreamble) {
        // Any dotted key implicitly defines its table, including keys outside the promotion allowlist.
        const parsed = parseTomlKeyPath(line)
        const isAssignment = parsed && line[parsed.end] === '='
        if (isAssignment && parsed.segments[0] === tableName && parsed.segments.length > 1) {
          hasDottedKey = true
          lastDottedKeyIndex = index
          const promotedKey = parsed.segments.length === 2 ? parsed.segments[1] : null
          if (promotedKey && updates.has(promotedKey)) {
            dottedKeyIndexes.set(promotedKey, index)
          }
          const descendantKey = parsed.segments.length > 2 ? parsed.segments[1] : null
          if (descendantKey && updates.has(descendantKey)) {
            blockedAbsentKeys.add(descendantKey)
          }
        } else if (
          isAssignment &&
          parsed.segments.length === 1 &&
          parsed.segments[0] === tableName
        ) {
          blocksNewTable = true
        }
      } else if (tableBodyActive) {
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
  if (tableBodyActive) {
    tableBodyEndIndex = lines.length
  }

  return {
    bareKeyIndexes,
    dottedKeyIndexes,
    hasBareTable: tableSeen,
    hasDottedKey,
    blocksNewTable,
    blockedAbsentKeys,
    bareBodyInsertIndex: computeBareBodyInsertIndex(lines, tableBodyHeaderIndex, tableBodyEndIndex),
    lastDottedKeyIndex
  }
}

// Insert before the next header: bare keys after a subtable header would belong to that subtable.
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

function appendNewTable(
  lines: string[],
  table: string,
  keyRenders: string[],
  usesCrlf: boolean
): void {
  let appendAt = lines.length
  while (appendAt > 0 && (lines[appendAt - 1] ?? '').trim() === '') {
    appendAt -= 1
  }
  const block = appendAt > 0 ? ['', `[${table}]`, ...keyRenders] : [`[${table}]`, ...keyRenders]
  lines.splice(appendAt, 0, ...block.map((line) => withCrLine(line, usesCrlf)))
}
