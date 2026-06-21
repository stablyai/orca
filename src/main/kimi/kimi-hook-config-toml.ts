// Kimi Code keeps all preferences in TOML (`~/.kimi-code/config.toml`) and reads
// lifecycle hooks from an array of `[[hooks]]` tables. There is no JSON settings
// file to reuse the shared JSON installer with, and no TOML library is vendored,
// so Orca manages only its own marker-delimited block: install rewrites the
// block, remove strips it, and arbitrary user config outside the markers is left
// untouched. Appending table headers is always valid TOML, so the block can live
// at the end of any existing file.

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

const BLOCK_START = '# >>> orca-managed-kimi-hooks (managed by Orca; do not edit) >>>'
const BLOCK_END = '# <<< orca-managed-kimi-hooks <<<'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Matches the managed block plus any blank lines immediately preceding it so
// repeated install/remove cycles do not accumulate whitespace. The `|$`
// fallback also matches from BLOCK_START to end-of-file when the trailing
// BLOCK_END marker is missing (e.g. a hand-edit deleted it): the managed block
// is always written last, so this recovers orphaned hook tables and lets
// install re-converge in one step instead of appending a duplicate block.
const MANAGED_BLOCK_RE = new RegExp(
  `\\n*${escapeRegExp(BLOCK_START)}[\\s\\S]*?(?:${escapeRegExp(BLOCK_END)}[^\\n]*|$)`,
  'g'
)

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

export function buildManagedKimiHooksBlock(command: string): string {
  const commandLiteral = tomlBasicString(command)
  // Omit `matcher`: Kimi treats it as a regex (so Claude's literal "*" is
  // invalid) and an absent matcher already matches every tool.
  const entries = KIMI_HOOK_EVENTS.map((event) =>
    [`[[hooks]]`, `event = "${event}"`, `command = ${commandLiteral}`].join('\n')
  )
  return [BLOCK_START, ...entries, BLOCK_END].join('\n')
}

export function applyManagedKimiHooks(configText: string, command: string): string {
  const withoutManaged = configText.replace(MANAGED_BLOCK_RE, '').replace(/\s+$/, '')
  const block = buildManagedKimiHooksBlock(command)
  return withoutManaged.length > 0 ? `${withoutManaged}\n\n${block}\n` : `${block}\n`
}

export function removeManagedKimiHooks(configText: string): { text: string; changed: boolean } {
  // Why: compare instead of MANAGED_BLOCK_RE.test() — the regex carries the `g`
  // flag, so .test() advances lastIndex and would behave inconsistently across
  // calls. .replace() ignores/resets lastIndex, so it is safe to reuse.
  const stripped = configText.replace(MANAGED_BLOCK_RE, '')
  if (stripped === configText) {
    return { text: configText, changed: false }
  }
  const trimmed = stripped.replace(/\s+$/, '')
  return { text: trimmed.length > 0 ? `${trimmed}\n` : '', changed: true }
}

// Returns the managed events present in the block whose command still matches an
// Orca-managed script (by filename, so a moved userData path is still swept).
export function readManagedKimiHookEvents(
  configText: string,
  isManagedCommand: (command: string | undefined) => boolean
): Set<string> {
  const present = new Set<string>()
  const match = configText.match(MANAGED_BLOCK_RE)
  if (!match) {
    return present
  }
  const blockText = match[0]
  // Split on each table header and pair the `event`/`command` lines within.
  for (const chunk of blockText.split('[[hooks]]').slice(1)) {
    const event = chunk.match(/event\s*=\s*"([^"]+)"/)?.[1]
    const command = chunk.match(/command\s*=\s*"((?:[^"\\]|\\.)*)"/)?.[1]
    if (event && isManagedCommand(command)) {
      present.add(event)
    }
  }
  return present
}
