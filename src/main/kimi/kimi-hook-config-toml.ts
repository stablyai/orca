// Preserve user TOML while managing marker blocks and positively recognized Orca hook tables.

import { MANAGED_HOOK_TIMEOUT_SECONDS } from '../agent-hooks/installer-utils'
import {
  findManagedTomlBlocks,
  findRecognizedManagedTables,
  stripManagedTomlRegions,
  type ManagedTomlMarkers,
  type ManagedTomlRegion,
  type RecognizedManagedTable
} from '../agent-hooks/managed-toml-ownership'

export const KIMI_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure'
] as const

const MARKERS: ManagedTomlMarkers = {
  startMarker: '# >>> orca-managed-kimi-hooks (managed by Orca; do not edit) >>>',
  endMarker: '# <<< orca-managed-kimi-hooks <<<'
}
const HOOK_TABLE_HEADER = '[[hooks]]'

export type ManagedCommandMatcher = (command: string | undefined) => boolean

// Command paths confer ownership even with extra keys; unknown multiline extents fail closed to preserve user bytes.
function matchManagedHookTable(
  lines: readonly string[],
  index: number,
  isManagedCommand: ManagedCommandMatcher
): { lineCount: number; value: string | null } | null {
  if (lines[index].trim() !== HOOK_TABLE_HEADER) {
    return null
  }
  const pairs = new Map<string, string>()
  let cursor = index + 1
  while (cursor < lines.length) {
    const line = lines[cursor].trim()
    // A blank, the next table header or a comment (the end marker included)
    // ends the table's key run.
    if (line === '' || line.startsWith('[') || line.startsWith('#')) {
      break
    }
    const pair = line.match(/^([A-Za-z_][\w-]*)\s*=\s*(.*)$/)
    if (!pair || pairs.has(pair[1])) {
      return null
    }
    pairs.set(pair[1], pair[2].trim())
    cursor++
  }
  // TOML gaps do not end tables; later keys make this partial run unsafe to splice.
  if (keysFollowGap(lines, cursor)) {
    return null
  }
  // Raw (still-escaped) literal; createManagedCommandMatcher normalizes separators itself.
  const command = readTomlString(pairs.get('command'))
  if (!isManagedCommand(command)) {
    return null
  }
  return { lineCount: cursor - index, value: readEventName(pairs.get('event')) }
}

function keysFollowGap(lines: readonly string[], from: number): boolean {
  for (let cursor = from; cursor < lines.length; cursor++) {
    const line = lines[cursor].trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }
    return !line.startsWith('[')
  }
  return false
}

// Basic or literal TOML string, ignoring any inline comment after it.
function readTomlString(value: string | undefined): string | undefined {
  return value?.match(/^"((?:[^"\\]|\\.)*)"/)?.[1] ?? value?.match(/^'([^']*)'/)?.[1]
}

// Unreadable command-owned events must report partial, not absent; raw text cannot match a known event.
function readEventName(value: string | undefined): string | null {
  if (value === undefined) {
    return null
  }
  return readTomlString(value) ?? value.trim() ?? null
}

function recognizeManagedTables(
  configText: string,
  isManagedCommand: ManagedCommandMatcher
): RecognizedManagedTable<string | null>[] {
  return findRecognizedManagedTables(configText, (lines, index) =>
    matchManagedHookTable(lines, index, isManagedCommand)
  )
}

// Own matched marker pairs and positively recognized tables wherever edits moved them.
function findOwnedRegions(
  configText: string,
  isManagedCommand: ManagedCommandMatcher
): ManagedTomlRegion[] {
  return [
    ...findManagedTomlBlocks(configText, MARKERS),
    ...recognizeManagedTables(configText, isManagedCommand)
  ]
}

// Escape Windows fallback paths for TOML basic strings.
function tomlBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // Control chars would make Kimi's TOML parser reject the file.
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

export function buildManagedKimiHooksBlock(command: string, eol = '\n'): string {
  const commandLiteral = tomlBasicString(command)
  // Kimi treats matcher as regex (so * is invalid); omit it except to scope SessionStart. Host timeout backs up the normal curl deadline.
  const entries = KIMI_HOOK_EVENTS.map((event) =>
    [
      HOOK_TABLE_HEADER,
      `event = "${event}"`,
      // Why: Kimi awaits SessionStart during a new session's first prompt; only a resume is used.
      ...(event === 'SessionStart' ? ['matcher = "^resume$"'] : []),
      `command = ${commandLiteral}`,
      `timeout = ${MANAGED_HOOK_TIMEOUT_SECONDS}`
    ].join(eol)
  )
  return [MARKERS.startMarker, ...entries, MARKERS.endMarker].join(eol)
}

function detectEol(configText: string): string {
  return configText.includes('\r\n') ? '\r\n' : '\n'
}

export function applyManagedKimiHooks(
  configText: string,
  command: string,
  isManagedCommand: ManagedCommandMatcher
): string {
  const eol = detectEol(configText)
  const withoutManaged = stripManagedTomlRegions(
    configText,
    findOwnedRegions(configText, isManagedCommand)
  ).text.replace(/\s+$/, '')
  const block = buildManagedKimiHooksBlock(command, eol)
  return withoutManaged.length > 0
    ? `${withoutManaged}${eol}${eol}${block}${eol}`
    : `${block}${eol}`
}

export function removeManagedKimiHooks(
  configText: string,
  isManagedCommand: ManagedCommandMatcher
): { text: string; changed: boolean } {
  const stripped = stripManagedTomlRegions(
    configText,
    findOwnedRegions(configText, isManagedCommand)
  )
  if (!stripped.changed) {
    return { text: configText, changed: false }
  }
  const eol = detectEol(configText)
  const trimmed = stripped.text.replace(/\s+$/, '')
  return { text: trimmed.length > 0 ? `${trimmed}${eol}` : '', changed: true }
}

// Count managed tables outside markers too: they still emit events and must not appear uninstalled.
export function readManagedKimiHookEvents(
  configText: string,
  isManagedCommand: ManagedCommandMatcher
): Set<string> {
  const events = new Set<string>()
  for (const table of recognizeManagedTables(configText, isManagedCommand)) {
    if (table.value) {
      events.add(table.value)
    }
  }
  return events
}
