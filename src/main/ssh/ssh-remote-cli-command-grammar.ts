/**
 * Per-command flag grammar for the SSH shim, which has no local `CommandSpec` registry.
 * Boolean flags decide whether the next token is a value; repeatable flags decide whether
 * multiple occurrences fold into one separator-joined value instead of last-value-wins.
 */
export type RemoteFlagOccurrence = { name: string; value: string | boolean }

export const LINEAR_PROJECT_EDIT_COMMAND = ['linear', 'project', 'edit']

/** No `--clear-status`, `--clear-color` or `--clear-teams`: those Linear fields cannot become empty. */
export const LINEAR_PROJECT_EDIT_CLEAR_FLAGS = [
  'clear-description',
  'clear-content',
  'clear-lead',
  'clear-members',
  'clear-labels',
  'clear-start-date',
  'clear-target-date'
] as const

const LINEAR_PROJECT_EDIT_REPEATABLE_FLAGS = ['team', 'member', 'label'] as const

export const REPEATED_FLAG_SEPARATOR = '\u0000'

type RemoteCommandGrammar = {
  command: readonly string[]
  booleanFlags?: readonly string[]
  repeatableFlags?: readonly string[]
}

const GLOBAL_REMOTE_BOOLEAN_FLAGS = new Set([
  'all',
  'attachments',
  'children',
  'comments',
  'current',
  'full',
  'help',
  'hide-diff',
  'inject',
  'include-archived',
  'include-visual-layouts',
  'json',
  'me',
  'relations',
  'parent-current',
  'unread',
  'updates',
  'wait'
])

const REMOTE_COMMAND_GRAMMARS: readonly RemoteCommandGrammar[] = [
  // Why: Android launch already uses `--activity <name>`; only Linear issue reads take it as a boolean.
  { command: ['linear', 'issue'], booleanFlags: ['activity'] },
  { command: ['linear', 'create'], repeatableFlags: ['label'] },
  { command: ['linear', 'save-issue'], repeatableFlags: ['label'] },
  { command: ['linear', 'label', 'add'], repeatableFlags: ['label'] },
  { command: ['linear', 'label', 'remove'], repeatableFlags: ['label'] },
  { command: ['linear', 'label', 'set'], repeatableFlags: ['label'] },
  { command: ['linear', 'project', 'create'], repeatableFlags: ['team', 'member', 'label'] },
  // Why: the clear flags must be boolean here or `--clear-lead <project>` would eat the target.
  {
    command: LINEAR_PROJECT_EDIT_COMMAND,
    booleanFlags: LINEAR_PROJECT_EDIT_CLEAR_FLAGS,
    repeatableFlags: LINEAR_PROJECT_EDIT_REPEATABLE_FLAGS
  }
]

export function isRemoteBooleanFlag(flag: string, commandPath: readonly string[]): boolean {
  return (
    GLOBAL_REMOTE_BOOLEAN_FLAGS.has(flag) ||
    matchingGrammars(commandPath).some((grammar) => grammar.booleanFlags?.includes(flag) === true)
  )
}

export function remoteRepeatableFlags(commandPath: readonly string[]): ReadonlySet<string> {
  return new Set(matchingGrammars(commandPath).flatMap((grammar) => grammar.repeatableFlags ?? []))
}

export function foldRemoteFlagOccurrences(
  commandPath: readonly string[],
  occurrences: readonly RemoteFlagOccurrence[]
): Map<string, string | boolean> {
  const repeatable = remoteRepeatableFlags(commandPath)
  const flags = new Map<string, string | boolean>()
  for (const { name, value } of occurrences) {
    // Why: `--flag=false` means the flag was not requested. Deleting rather than storing
    // `false` matches the local parser for consumers that read presence, and keeps a later
    // `--flag` winning over an earlier `--flag=false` on both transports.
    if (value === false) {
      flags.delete(name)
      continue
    }
    const previous = flags.get(name)
    if (repeatable.has(name) && typeof previous === 'string') {
      // Why: a trailing valueless `--member` must not wipe the members already
      // collected, which is what the local parser does by dropping non-strings.
      if (typeof value === 'string') {
        flags.set(name, `${previous}${REPEATED_FLAG_SEPARATOR}${value}`)
      }
      continue
    }
    flags.set(name, value)
  }
  return flags
}

function matchingGrammars(commandPath: readonly string[]): RemoteCommandGrammar[] {
  return REMOTE_COMMAND_GRAMMARS.filter((grammar) =>
    grammar.command.every((part, index) => commandPath[index] === part)
  )
}
