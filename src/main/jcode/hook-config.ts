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

// Why the comment tail: jcode ships `pre_tool_timeout_ms = 5000` and a user may
// annotate it. Rejecting that set parseError, which made install() and getStatus()
// report `error` and blocked the whole integration over one ordinary comment.
const TOML_SCALAR_VALUE_RE =
  /^\s*(?:true|false|[-+]?\d[\d_]*(?:\.[\d_]+)?(?:[eE][-+]?\d+)?)\s*(?:#.*)?\r?$/

function isTomlScalarValue(line: string, offset: number): boolean {
  return TOML_SCALAR_VALUE_RE.test(line.slice(offset))
}

// Why the shared parser: it already handles quoted (`['hooks']`) and dotted keys.
// Rolling our own missed those spellings, so apply() appended a SECOND [hooks]
// table and jcode then failed to parse the whole config.
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
  // Why: a CRLF config leaves a trailing `\r` on each split line; re-joining
  // with the CRLF eol would double it into `\r\r\n` and grow the file per edit.
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
          // Why the parsed value and not the raw line: a user-owned command whose
          // trailing comment merely mentions the managed script would otherwise read
          // as managed, and on Windows tomlQuoteString escapes `\` so the raw line
          // never matched Orca's own value at all.
          const value = parseTomlSingleLineStringValue(line, parsed.end + 1)?.value
          if (!isManaged(value)) {
            userOwnedEvents.push(key)
          } else if (value === managedCommand) {
            existingKeyIndexes.set(key, index)
          } else {
            // A managed entry pointing at a script that no longer exists — a copied
            // ~/.jcode, or a platform switch between .sh and .cmd. Rewrite it, or the
            // hooks stay broken with no Orca action able to repair them.
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
      // Why: append a new [hooks] table at the end; jcode re-reads config on
      // reload, so placement at EOF is safe.
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
  // Why: same CRLF strip as applyJcodeManagedHooks so re-joining never doubles `\r`.
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
      // Why: leaving the table stops the removal, but the rest of the file must
      // still be copied out — `kept` is the whole result, so breaking here once
      // truncated every table declared after [hooks].
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
