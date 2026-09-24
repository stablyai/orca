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
  // Why: repeatability is per-command vocabulary. `--agent` repeats for `search`
  // and is single-valued for `worktree create`, which one global set cannot say.
  repeatableFlags?: string[]
  positionalArgs?: string[]
  examples?: string[]
  notes?: string[]
}

export function specPaths(spec: CommandSpec): string[][] {
  return spec.aliases ? [spec.path, ...spec.aliases] : [spec.path]
}
