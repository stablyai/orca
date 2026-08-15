// Why: byte-preserving edits of jcode's `~/.jcode/config.toml` [hooks] table,
// following the codebase convention of hand-rolled TOML scanning (no TOML
// dependency, see src/main/codex/config-toml-line-scan.ts). jcode hook values
// are scalar commands; user-owned values are left untouched so Orca never
// silently disables a user's own hook.
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState,
  parseTomlSingleLineStringValue
} from '../codex/config-toml-line-scan'
import { parseTomlKeyPath } from '../codex/config-toml-key-path'
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
      inHooksTable = parseTomlTablePath(header)?.join('.') === 'hooks'
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
          // Why: a multiline string hook value is not a scalar command; treat
          // the whole table as unmanaged so install reports `error` instead of
          // clobbering it. Scalar non-string values (jcode's own
          // `pre_tool_timeout_ms = 5000`) are legitimate config, just not
          // commands, so they are skipped.
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

const TOML_SCALAR_VALUE_RE = /^\s*(?:true|false|[-+]?\d[\d_]*(?:\.[\d_]+)?(?:[eE][-+]?\d+)?)\s*$/

function isTomlScalarValue(line: string, offset: number): boolean {
  return TOML_SCALAR_VALUE_RE.test(line.slice(offset))
}

function parseTomlTablePath(header: string): string[] | null {
  const trimmed = header.trim().replace(/^\[+|\]+$/g, '')
  if (trimmed.length === 0) {
    return null
  }
  return trimmed.split('.').map((segment) => segment.trim().replace(/^"|"$/g, ''))
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
  const lines = content.split('\n')
  const usesCrlf = content.includes('\r\n')
  const eol = usesCrlf ? '\r\n' : '\n'
  let state = createTomlLineScanState()
  let inHooksTable = false
  let hooksHeaderIndex = -1
  const existingKeyIndexes = new Map<string, number>()
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
      if (parseTomlTablePath(header)?.join('.') === 'hooks') {
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
          if (isManaged(line)) {
            existingKeyIndexes.set(key, index)
          } else {
            userOwnedEvents.push(key)
          }
        }
      }
    }
    state = updateTomlLineScanState(state, line)
  }

  const missing = events.filter(
    (event) => !existingKeyIndexes.has(event) && !userOwnedEvents.includes(event)
  )
  const insertions: string[] = []
  for (const event of missing) {
    insertions.push(`${event} = ${tomlQuoteString(managedCommand)}`)
  }
  let result = content
  if (insertions.length > 0) {
    if (hooksHeaderIndex === -1) {
      // Why: append a new [hooks] table at the end; jcode re-reads config on
      // reload, so placement at EOF is safe.
      result = `${result.endsWith('\n') || result.length === 0 ? result : `${result}\n`}[hooks]${eol}${insertions.join(eol)}${eol}`
    } else {
      const insertionLines = [...lines]
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
  const lines = content.split('\n')
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
      if (inHooksTable) {
        break
      }
      if (parseTomlTablePath(header)?.join('.') === 'hooks') {
        inHooksTable = true
      }
      kept.push(line)
      state = updateTomlLineScanState(state, line)
      continue
    }
    if (inHooksTable) {
      const parsed = parseTomlKeyPath(line)
      if (parsed && line[parsed.end] === '=' && parsed.segments.length === 1 && isManaged(line)) {
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
