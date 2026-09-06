// Mistral Vibe reads lifecycle hooks from an array of `[[hooks]]` tables in TOML
// (`~/.vibe/hooks.toml` user-global, `.vibe/hooks.toml` project). There is no JSON
// settings file and no vendored TOML library, so Orca manages only its own
// marker-delimited block: install rewrites the block, remove strips it, and
// arbitrary user config outside the markers is left untouched. Appending table
// headers is always valid TOML, so the block can live at the end of any file.
//
// Source of truth for the hook schema: vibe/core/hooks/models.py (HookConfig).
// Vibe uses `type` (pre_tool/post_tool/post_agent) and `match` (fnmatch glob;
// invalid for post_agent). An absent `match` already matches every tool.

import { MANAGED_HOOK_TIMEOUT_SECONDS } from '../agent-hooks/installer-utils'
import { escapeRegex } from '../../shared/string-utils'

// Why: the three hook points Vibe exposes. Each maps to a working/done transition
// in normalizeVibeEvent. post_agent has no `match` field (fires per turn, not per tool).
export const VIBE_HOOK_TYPES = ['pre_tool', 'post_tool', 'post_agent'] as const

const BLOCK_START = '# >>> orca-managed-vibe-hooks (managed by Orca; do not edit) >>>'
const BLOCK_END = '# <<< orca-managed-vibe-hooks <<<'

// Matches the managed block plus any blank lines immediately preceding it so
// repeated install/remove cycles do not accumulate whitespace. The `|$`
// fallback also matches from BLOCK_START to end-of-file when the trailing
// BLOCK_END marker is missing (e.g. a hand-edit deleted it): the managed block
// is always written last, so this recovers orphaned hook tables and lets
// install re-converge in one step instead of appending a duplicate block.
const MANAGED_BLOCK_RE = new RegExp(
  `\\n*${escapeRegex(BLOCK_START)}[\\s\\S]*?(?:${escapeRegex(BLOCK_END)}[^\\n]*|$)`,
  'g'
)

// TOML basic (double-quoted) string. The managed command may contain single
// quotes (from POSIX quoting) but no double quotes or backslashes on the paths
// Orca generates; escape both defensively anyway.
function tomlBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // Control chars would make Vibe's TOML parser reject the file.
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

export function buildManagedVibeHooksBlock(command: string): string {
  const commandLiteral = tomlBasicString(command)
  const entries = VIBE_HOOK_TYPES.map((type) =>
    [
      `[[hooks]]`,
      `name = "orca-${type.replace('_', '-')}"`,
      `type = "${type}"`,
      // post_agent fires per turn, not per tool; Vibe rejects `match` on post_agent.
      ...(type === 'post_agent' ? [] : [`match = "*"`]),
      `command = ${commandLiteral}`,
      `timeout = ${MANAGED_HOOK_TIMEOUT_SECONDS}`,
      `description = "Orca status hook (managed)"`
    ].join('\n')
  )
  return [BLOCK_START, ...entries, BLOCK_END].join('\n')
}

export function applyManagedVibeHooks(configText: string, command: string): string {
  const withoutManaged = configText.replace(MANAGED_BLOCK_RE, '').replace(/\s+$/, '')
  const block = buildManagedVibeHooksBlock(command)
  return withoutManaged.length > 0 ? `${withoutManaged}\n\n${block}\n` : `${block}\n`
}

export function removeManagedVibeHooks(configText: string): { text: string; changed: boolean } {
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

// Returns the managed hook types present in the block whose command still matches
// an Orca-managed script (by filename, so a moved userData path is still swept).
export function readManagedVibeHookTypes(
  configText: string,
  isManagedCommand: (command: string | undefined) => boolean
): Set<string> {
  const present = new Set<string>()
  const match = configText.match(MANAGED_BLOCK_RE)
  if (!match) {
    return present
  }
  const blockText = match[0]
  for (const chunk of blockText.split('[[hooks]]').slice(1)) {
    const type = chunk.match(/type\s*=\s*"([^"]+)"/)?.[1]
    const command = chunk.match(/command\s*=\s*"((?:[^"\\]|\\.)*)"/)?.[1]
    if (type && isManagedCommand(command)) {
      present.add(type)
    }
  }
  return present
}
