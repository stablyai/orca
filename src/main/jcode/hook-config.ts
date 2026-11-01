// Reuse byte-preserving TOML scanning; scalar hook commands stay user-owned unless they target Orca.
import { applyEdits, type Edit } from 'jsonc-parser'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState,
  parseTomlSingleLineStringValue
} from '../codex/config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from '../codex/config-toml-key-path'
import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'
import {
  appendJcodeHookCommand,
  removeJcodeHookCommand,
  scanJcodeHookCommandArray
} from './hook-command-array'

export type JcodeHooksTable = Record<string, string | readonly string[]>

type JcodeHookAssignment = {
  key: string
  dotted: boolean
  lineStart: number
  /** Excludes the line terminator. */
  lineEnd: number
  valueStart: number
}

function scanJcodeHookAssignments(content: string): {
  assignments: JcodeHookAssignment[]
  /** End of the first [hooks] header line, or -1 when there is none. */
  hooksHeaderEnd: number
} {
  const assignments: JcodeHookAssignment[] = []
  let hooksHeaderEnd = -1
  let state = createTomlLineScanState()
  let inHooksTable = false
  let lineStart = 0
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (isTomlStructuralLine(state)) {
      const header = getTomlTableHeader(line)
      if (header) {
        inHooksTable = isHooksTableHeader(header)
        if (inHooksTable && hooksHeaderEnd === -1) {
          hooksHeaderEnd = lineStart + line.length
        }
      } else if (inHooksTable) {
        const parsed = parseTomlKeyPath(line)
        if (parsed && line[parsed.end] === '=') {
          assignments.push({
            key: parsed.segments[0],
            dotted: parsed.segments.length > 1,
            lineStart,
            lineEnd: lineStart + line.length,
            valueStart: lineStart + parsed.end + 1
          })
        }
      }
    }
    state = updateTomlLineScanState(state, line)
    lineStart += rawLine.length + 1
  }
  return { assignments, hooksHeaderEnd }
}

export function parseJcodeHooksTable(content: string): JcodeHooksTable | null {
  const hooks: JcodeHooksTable = {}
  for (const assignment of scanJcodeHookAssignments(content).assignments) {
    const value = parseTomlSingleLineStringValue(content, assignment.valueStart)
    const array = value ? null : scanJcodeHookCommandArray(content, assignment.valueStart)
    if (value) {
      hooks[assignment.key] = value.value
    } else if (array) {
      hooks[assignment.key] = array.elements.map((element) => element.value)
    } else if (
      !assignment.dotted &&
      !isTomlScalarValue(content.slice(assignment.valueStart, assignment.lineEnd))
    ) {
      // Fail closed on multiline strings and malformed arrays; numeric settings such as pre_tool_timeout_ms are valid.
      return null
    }
  }
  return hooks
}

// jcode seeds non-command scalars; inline comments must not make them parse errors.
const TOML_SCALAR_VALUE_RE =
  /^\s*(?:true|false|[-+]?\d[\d_]*(?:\.[\d_]+)?(?:[eE][-+]?\d+)?)\s*(?:#.*)?$/

function isTomlScalarValue(value: string): boolean {
  return TOML_SCALAR_VALUE_RE.test(value)
}

// Reuse quoted/dotted header parsing to avoid appending a duplicate hooks table.
function isHooksTableHeader(header: string): boolean {
  return parseTomlTableHeaderPath(header)?.segments.join('.') === 'hooks'
}

export function tomlQuoteString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export type JcodeHooksEdit = {
  content: string
  /** Managed keys whose value is a user-owned command (kept, reported partial). */
  userOwnedEvents: readonly string[]
}

export function applyJcodeManagedHooks(
  source: string,
  events: readonly string[],
  managedCommand: string,
  scriptFileName: string
): JcodeHooksEdit {
  const isManaged = createManagedCommandMatcher(scriptFileName)
  // Keep one Orca element per array so the repair below cannot leave stale duplicates running.
  const content = removeManagedHookCommands(source, isManaged, true)
  const managedValue = tomlQuoteString(managedCommand)
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const { assignments, hooksHeaderEnd } = scanJcodeHookAssignments(content)
  const edits: Edit[] = []
  const userOwnedEvents: string[] = []
  const missing: string[] = []
  for (const event of events) {
    const assignment = assignments.find((entry) => entry.key === event && !entry.dotted)
    if (!assignment) {
      missing.push(event)
      continue
    }
    const array = scanJcodeHookCommandArray(content, assignment.valueStart)
    if (array) {
      // Append after user gates: jcode runs every pre_tool command in order, so Orca observes the final input.
      if (!array.elements.some((element) => element.value === managedCommand)) {
        const stale = array.elements.find((element) => isManaged(element.value))
        edits.push(
          ...(stale
            ? [{ offset: stale.start, length: stale.end - stale.start, content: managedValue }]
            : appendJcodeHookCommand(content, array, managedValue))
        )
      }
      continue
    }
    // Parse the string so trailing comments cannot confer ownership and escaped Windows paths still match.
    const value = parseTomlSingleLineStringValue(content, assignment.valueStart)?.value
    if (!isManaged(value)) {
      userOwnedEvents.push(event)
    } else if (value !== managedCommand) {
      // Repair stale managed paths after copied configs or platform switches.
      edits.push({
        offset: assignment.lineStart,
        length: assignment.lineEnd - assignment.lineStart,
        content: `${event} = ${managedValue}`
      })
    }
  }
  if (missing.length > 0) {
    const lines = missing.map((event) => `${event} = ${managedValue}`).join(eol)
    edits.push(
      hooksHeaderEnd === -1
        ? {
            offset: content.length,
            length: 0,
            content: `${content.endsWith('\n') || content.length === 0 ? '' : '\n'}[hooks]${eol}${lines}${eol}`
          }
        : { offset: hooksHeaderEnd, length: 0, content: `${eol}${lines}` }
    )
  }
  return { content: applyEdits(content, edits), userOwnedEvents }
}

export function removeJcodeManagedHooks(
  content: string,
  scriptFileName: string
): { content: string; changed: boolean } {
  const result = removeManagedHookCommands(
    content,
    createManagedCommandMatcher(scriptFileName),
    false
  )
  return { content: result, changed: result !== content }
}

function removeManagedHookCommands(
  content: string,
  isManaged: (command: string | undefined) => boolean,
  keepFirst: boolean
): string {
  let result = content
  // Each pass drops at most one element per array so splices never overlap.
  for (let edits = getRemovalEdits(result, isManaged, keepFirst); edits.length > 0;) {
    result = applyEdits(result, edits)
    edits = getRemovalEdits(result, isManaged, keepFirst)
  }
  return result
}

function getRemovalEdits(
  content: string,
  isManaged: (command: string | undefined) => boolean,
  keepFirst: boolean
): Edit[] {
  const edits: Edit[] = []
  // Scan every [hooks] line so removal cannot truncate later user tables.
  for (const assignment of scanJcodeHookAssignments(content).assignments) {
    if (assignment.dotted) {
      continue
    }
    const array = scanJcodeHookCommandArray(content, assignment.valueStart)
    const managed = array?.elements.flatMap((element, i) => (isManaged(element.value) ? [i] : []))
    const index = managed?.[keepFirst ? 1 : 0]
    if (array && index !== undefined) {
      edits.push(...removeJcodeHookCommand(content, array, index))
    } else if (
      !array &&
      !keepFirst &&
      isManaged(parseTomlSingleLineStringValue(content, assignment.valueStart)?.value)
    ) {
      const nextLine = content.indexOf('\n', assignment.lineEnd)
      const end = nextLine === -1 ? content.length : nextLine + 1
      edits.push({ offset: assignment.lineStart, length: end - assignment.lineStart, content: '' })
    }
  }
  return edits
}
