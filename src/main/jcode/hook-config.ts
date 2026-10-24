// Reuse byte-preserving TOML scanning; scalar hook commands stay user-owned unless they target Orca.
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState,
  parseTomlSingleLineStringValue
} from '../codex/config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from '../codex/config-toml-key-path'
import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'

export type JcodeHooksTable = Record<string, string>

export function parseJcodeHooksTable(content: string): JcodeHooksTable | null {
  const hooks: JcodeHooksTable = {}
  let state = createTomlLineScanState()
  let inHooksTable = false
  let parseError = false
  for (const line of content.split('\n')) {
    if (!isTomlStructuralLine(state)) {
      state = updateTomlLineScanState(state, line)
      continue
    }
    const header = getTomlTableHeader(line)
    if (header) {
      inHooksTable = isHooksTableHeader(header)
      state = updateTomlLineScanState(state, line)
      continue
    }
    if (inHooksTable) {
      const parsed = parseTomlKeyPath(line)
      if (parsed && line[parsed.end] === '=') {
        const value = parseTomlSingleLineStringValue(line, parsed.end + 1)
        if (value) {
          hooks[parsed.segments[0]] = value.value
        } else if (
          parsed.segments.length === 1 &&
          line.trim().length > 0 &&
          !isTomlScalarValue(line, parsed.end + 1)
        ) {
          // Fail closed on multiline hook strings; non-string scalars such as pre_tool_timeout_ms are valid config.
          parseError = true
        }
      }
    }
    state = updateTomlLineScanState(state, line)
  }
  if (parseError) {
    return null
  }
  return hooks
}

// jcode seeds non-command scalars; inline comments must not make them parse errors.
const TOML_SCALAR_VALUE_RE =
  /^\s*(?:true|false|[-+]?\d[\d_]*(?:\.[\d_]+)?(?:[eE][-+]?\d+)?)\s*(?:#.*)?\r?$/

function isTomlScalarValue(line: string, offset: number): boolean {
  return TOML_SCALAR_VALUE_RE.test(line.slice(offset))
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
  content: string,
  events: readonly string[],
  managedCommand: string,
  scriptFileName: string
): JcodeHooksEdit {
  const isManaged = createManagedCommandMatcher(scriptFileName)
  // Strip split CRLF tails before rejoining so repeated edits cannot grow carriage returns.
  const lines = content.split('\n').map((line) => line.replace(/\r$/, ''))
  const usesCrlf = content.includes('\r\n')
  const eol = usesCrlf ? '\r\n' : '\n'
  let state = createTomlLineScanState()
  let inHooksTable = false
  let hooksHeaderIndex = -1
  const existingKeyIndexes = new Map<string, number>()
  const staleKeyIndexes = new Map<string, number>()
  const userOwnedEvents: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!isTomlStructuralLine(state)) {
      state = updateTomlLineScanState(state, line)
      continue
    }
    const header = getTomlTableHeader(line)
    if (header) {
      if (inHooksTable) {
        break
      }
      if (isHooksTableHeader(header)) {
        inHooksTable = true
        hooksHeaderIndex = index
      }
      state = updateTomlLineScanState(state, line)
      continue
    }
    if (inHooksTable) {
      const parsed = parseTomlKeyPath(line)
      if (parsed && line[parsed.end] === '=' && parsed.segments.length === 1) {
        const key = parsed.segments[0]
        if (events.includes(key)) {
          // Parse the string so trailing comments cannot confer ownership and escaped Windows paths still match.
          const value = parseTomlSingleLineStringValue(line, parsed.end + 1)?.value
          if (!isManaged(value)) {
            userOwnedEvents.push(key)
          } else if (value === managedCommand) {
            existingKeyIndexes.set(key, index)
          } else {
            // Repair stale managed paths after copied configs or platform switches.
            staleKeyIndexes.set(key, index)
          }
        }
      }
    }
    state = updateTomlLineScanState(state, line)
  }

  const missing = events.filter(
    (event) =>
      !existingKeyIndexes.has(event) &&
      !staleKeyIndexes.has(event) &&
      !userOwnedEvents.includes(event)
  )
  const insertions: string[] = []
  for (const event of missing) {
    insertions.push(`${event} = ${tomlQuoteString(managedCommand)}`)
  }
  const repointed = [...lines]
  for (const [event, index] of staleKeyIndexes) {
    repointed[index] = `${event} = ${tomlQuoteString(managedCommand)}`
  }
  let result = staleKeyIndexes.size > 0 ? repointed.join(eol) : content
  if (insertions.length > 0) {
    if (hooksHeaderIndex === -1) {
      result = `${result.endsWith('\n') || result.length === 0 ? result : `${result}\n`}[hooks]${eol}${insertions.join(eol)}${eol}`
    } else {
      const insertionLines = [...repointed]
      insertionLines.splice(hooksHeaderIndex + 1, 0, ...insertions)
      result = insertionLines.join(eol)
    }
  }
  return { content: result, userOwnedEvents }
}

export function removeJcodeManagedHooks(
  content: string,
  scriptFileName: string
): { content: string; changed: boolean } {
  const isManaged = createManagedCommandMatcher(scriptFileName)
  // Strip CRLF tails before rejoining.
  const lines = content.split('\n').map((line) => line.replace(/\r$/, ''))
  const usesCrlf = content.includes('\r\n')
  const eol = usesCrlf ? '\r\n' : '\n'
  let state = createTomlLineScanState()
  let inHooksTable = false
  let changed = false
  const kept: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!isTomlStructuralLine(state)) {
      kept.push(line)
      state = updateTomlLineScanState(state, line)
      continue
    }
    const header = getTomlTableHeader(line)
    if (header) {
      // Keep copying after the hooks table so removal cannot truncate later user tables.
      inHooksTable = isHooksTableHeader(header)
      kept.push(line)
      state = updateTomlLineScanState(state, line)
      continue
    }
    if (inHooksTable) {
      const parsed = parseTomlKeyPath(line)
      const value =
        parsed && line[parsed.end] === '=' && parsed.segments.length === 1
          ? parseTomlSingleLineStringValue(line, parsed.end + 1)?.value
          : undefined
      if (value !== undefined && isManaged(value)) {
        changed = true
        state = updateTomlLineScanState(state, line)
        continue
      }
    }
    kept.push(line)
    state = updateTomlLineScanState(state, line)
  }
  if (!changed) {
    return { content, changed: false }
  }
  return { content: kept.join(eol), changed: true }
}
