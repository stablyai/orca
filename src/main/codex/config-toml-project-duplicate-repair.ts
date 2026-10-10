import { parseTomlTableHeaderPath } from './config-toml-key-path'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { findProjectTrustLevelEntries } from './config-toml-project-trust-level'
import { escapeTomlBasicString } from './config-toml-syntax'

export type TomlTable = {
  /** Line index of the header; the body runs to the next table's header. */
  headerLine: number
  endLine: number
  header: string
  segments: string[] | null
  isArray: boolean
}

const ORCA_TRUST_LINE = 'trust_level = "trusted"'
const loggedRefusals = new Set<string>()

/**
 * Removes the duplicates older Orca builds wrote beside Codex-spelled trust
 * tables (#22592): an Orca-shaped `[projects."<p>"]`, `[hooks.state."<k>"]` or
 * empty `[hooks.state]` that repeats a table the user (or Codex) wrote in
 * another spelling, and the bare `trust_level` line Orca inserted under a
 * quoted `"trust_level"`. The user's table always wins; anything else leaves
 * the content untouched.
 */
export function repairOrcaDuplicateTrustTables(content: string): string {
  const lines = content.split('\n')
  const groups = new Map<string, TomlTable[]>()
  for (const table of readTomlTables(lines)) {
    if (getTrustTableKind(table) !== null) {
      const key = JSON.stringify(table.segments)
      groups.set(key, [...(groups.get(key) ?? []), table])
    }
  }
  const removedLines = new Set<number>()
  for (const group of groups.values()) {
    const userTables = group.filter((table) => !isOrcaWrittenTable(lines, table))
    const survivor = group.length === 1 ? group[0] : userTables[0]
    // Why: an identical spelling or two user tables cannot come from #22592, so only a person can merge them.
    if (
      !survivor ||
      (group.length > 1 &&
        (userTables.length !== 1 ||
          group.some((table) => table !== survivor && table.header === survivor.header)))
    ) {
      return refuseRepair(content, `duplicate table ${group[0]?.header}`)
    }
    for (const table of group) {
      if (table !== survivor) {
        for (let index = table.headerLine; index < table.endLine; index += 1) {
          removedLines.add(index)
        }
      }
    }
    if (getTrustTableKind(survivor) === 'project') {
      const insertedLine = findOrcaInsertedTrustLine(lines, survivor)
      if (insertedLine === 'unsafe') {
        return refuseRepair(content, `duplicate trust_level in ${survivor.header}`)
      }
      if (insertedLine !== null) {
        removedLines.add(insertedLine)
      }
    }
  }
  if (removedLines.size === 0) {
    return content
  }
  const kept = lines.filter((_, index) => !removedLines.has(index)).join('\n')
  const repaired = content.endsWith('\n') && !kept.endsWith('\n') ? `${kept}\n` : kept
  // Why: a partial repair would still fail Codex's parse, so only write a file it can load.
  const remainingDuplicate = findDuplicateTable(repaired)
  return remainingDuplicate === null
    ? repaired
    : refuseRepair(content, `duplicate table ${remainingDuplicate} remains`)
}

export function readTomlTables(lines: string[]): TomlTable[] {
  const tables: TomlTable[] = []
  let scanState = createTomlLineScanState()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const header = isTomlStructuralLine(scanState) ? getTomlTableHeader(line) : null
    scanState = updateTomlLineScanState(scanState, line)
    if (header === null) {
      continue
    }
    const previous = tables.at(-1)
    if (previous) {
      previous.endLine = index
    }
    const parsed = parseTomlTableHeaderPath(header)
    tables.push({
      headerLine: index,
      endLine: lines.length,
      header: header.trim(),
      segments: parsed?.segments ?? null,
      isArray: parsed?.isArray ?? false
    })
  }
  return tables
}

type TrustTableKind = 'project' | 'hook-state' | 'hook-state-parent'

export function getTrustTableKind(table: TomlTable): TrustTableKind | null {
  const segments = table.segments
  if (table.isArray || !segments) {
    return null
  }
  if (segments.length === 2 && segments[0] === 'projects') {
    return 'project'
  }
  if (segments[0] !== 'hooks' || segments[1] !== 'state') {
    return null
  }
  return segments.length === 2 ? 'hook-state-parent' : segments.length === 3 ? 'hook-state' : null
}

// Why: only the exact bytes Orca's writers emit are safe to delete without asking.
export function isOrcaWrittenTable(lines: string[], table: TomlTable): boolean {
  const header = stripCr(lines[table.headerLine])
  const body = lines
    .slice(table.headerLine + 1, table.endLine)
    .map(stripCr)
    .filter((line) => line.trim() !== '')
  const leaf = table.segments?.at(-1) ?? ''
  switch (getTrustTableKind(table)) {
    case 'project':
      return (
        header === `[projects."${escapeTomlBasicString(leaf)}"]` &&
        body.length === 1 &&
        body[0] === ORCA_TRUST_LINE
      )
    case 'hook-state':
      return (
        (header === `[hooks.state."${escapeTomlBasicString(leaf)}"]` ||
          header === `[hooks.state.'${leaf}']`) &&
        body.length === 2 &&
        /^enabled = (?:true|false)$/.test(body[0] ?? '') &&
        /^trusted_hash = "(?:[^"\\]|\\.)*"$/.test(body[1] ?? '')
      )
    case 'hook-state-parent':
      return header === '[hooks.state]' && body.length === 0
    case null:
      return false
  }
}

// Why: older Orca inserted its bare line directly under the header when it missed a quoted key.
function findOrcaInsertedTrustLine(lines: string[], table: TomlTable): number | 'unsafe' | null {
  const body = lines.slice(table.headerLine + 1, table.endLine).join('\n')
  const entries = findProjectTrustLevelEntries(body)
  if (entries.length < 2) {
    return null
  }
  const [inserted, ...others] = entries
  const isOrcaInsert =
    inserted?.start === 0 &&
    inserted.line === ORCA_TRUST_LINE &&
    others.length === 1 &&
    !/^[ \t]*trust_level/.test(others[0]?.line ?? '')
  return isOrcaInsert ? table.headerLine + 1 : 'unsafe'
}

function findDuplicateTable(content: string): string | null {
  const lines = content.split('\n')
  const seen = new Set<string>()
  for (const table of readTomlTables(lines)) {
    if (!table.segments || table.isArray) {
      continue
    }
    const key = JSON.stringify(table.segments)
    const body = lines.slice(table.headerLine + 1, table.endLine).join('\n')
    if (
      seen.has(key) ||
      (getTrustTableKind(table) === 'project' && findProjectTrustLevelEntries(body).length > 1)
    ) {
      return table.header
    }
    seen.add(key)
  }
  return null
}

function refuseRepair(content: string, reason: string): string {
  if (!loggedRefusals.has(reason)) {
    loggedRefusals.add(reason)
    console.warn(`[codex-config] Left a duplicate in config.toml unrepaired: ${reason}`)
  }
  return content
}

function stripCr(line: string | undefined): string {
  return (line ?? '').replace(/\r$/, '')
}
