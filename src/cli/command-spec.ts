export type CommandSpec = {
  path: string[]
  // Why: conventional alternate verbs should resolve without duplicating specs or handlers.
  aliases?: string[][]
  argumentMode?: 'parsed' | 'passthrough'
  // Why: typo recovery must never steer a benign mistake into destructive state changes.
  destructive?: boolean
  hidden?: boolean
  summary: string
  usage: string
  allowedFlags: string[]
  // Why: value-less and repeatable flags are per-command vocabulary. Declaring
  // them here keeps one command's flags out of the global parser, which cannot
  // scope `--agent` (repeatable for `search`, single-valued for `worktree create`).
  booleanFlags?: string[]
  repeatableFlags?: string[]
  positionalArgs?: string[]
  examples?: string[]
  notes?: string[]
}

export function specPaths(spec: CommandSpec): string[][] {
  return spec.aliases ? [spec.path, ...spec.aliases] : [spec.path]
}
