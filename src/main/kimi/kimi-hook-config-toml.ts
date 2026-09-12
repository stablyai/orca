// Kimi Code keeps all preferences in TOML (`~/.kimi-code/config.toml`) and reads
// lifecycle hooks from an array of `[[hooks]]` tables. There is no JSON settings
// file to reuse the shared JSON installer with, and no TOML library is vendored,
// so Orca manages only its own marker-delimited block: install rewrites the
// block, remove strips it, and user config is left untouched apart from hook
// tables Orca itself emitted. Appending table headers is always valid TOML, so
// the block can live at the end of any existing file.

import { MANAGED_HOOK_TIMEOUT_SECONDS } from '../agent-hooks/installer-utils'
import {
  findManagedTomlBlocks,
  findRecognizedManagedTables,
  stripManagedTomlRegions,
  type ManagedTomlMarkers,
  type ManagedTomlRegion,
  type RecognizedManagedTable
} from '../agent-hooks/managed-toml-ownership'

// Why: mirror the Claude-compatible events Orca normalizes for status. Kimi uses
// these exact event names (see normalizeKimiEvent), so each maps to a
// working/waiting/done transition.
export const KIMI_HOOK_EVENTS = [
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

// A `[[hooks]]` table that invokes Orca's managed script is Orca's hook: that
// command path is the only reason it fires, and it is there because Orca put it
// there. Extra keys are a user customising our hook, not authoring their own, so
// uninstall still owns it — leaving it would keep feeding Orca their events
// after they asked it to stop, and reinstall would double-fire the event.
//
// The key run is still parsed strictly: an unrecognized line shape (a multi-line
// array or string, say) means the table's extent is unknown, and guessing it
// would splice the wrong bytes. That case fails closed.
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
  // TOML lets blank lines and comments sit between keys of one table, so a gap
  // is not proof the table ended. If more keys follow it, the run above covered
  // only part of the table and splicing it would strand the rest without its
  // header — the extent is unknown, so fail closed.
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

// True when a key line follows the gap before the next table header, meaning
// the table extends past the bounded key run above.
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

// Ownership keys on the command, so an event Orca cannot parse must still
// register: status reporting `not_installed` for a table remove() will strip is
// the exact split this recognizer exists to close. An unreadable literal falls
// back to its raw text, which matches no known event and lands status on
// `partial` rather than claiming nothing is installed.
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

// Orca owns two things here: whatever sits inside a matched marker pair, and
// every table it can positively recognize wherever that table ended up.
function findOwnedRegions(
  configText: string,
  isManagedCommand: ManagedCommandMatcher
): ManagedTomlRegion[] {
  return [
    ...findManagedTomlBlocks(configText, MARKERS),
    ...recognizeManagedTables(configText, isManagedCommand)
  ]
}

// TOML basic (double-quoted) string. The managed command may contain single
// quotes (from POSIX quoting) but no double quotes or backslashes on the paths
// Orca generates; escape both defensively anyway.
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
  // Omit `matcher`: Kimi treats it as a regex (so Claude's literal "*" is
  // invalid) and an absent matcher already matches every tool.
  // `timeout` is the host-level backstop; the shell wrapper's curl budget is
  // the normal dead-endpoint bound.
  const entries = KIMI_HOOK_EVENTS.map((event) =>
    [
      HOOK_TABLE_HEADER,
      `event = "${event}"`,
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

// Events a managed table is live for, counted wherever the table sits (by script
// filename, so a moved userData path is still seen). Status must include tables
// stranded outside the markers — those still fire, so reporting them absent
// would tell the user a hook is uninstalled while Orca keeps receiving events.
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
