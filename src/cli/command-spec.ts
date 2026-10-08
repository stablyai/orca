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
  // Why: `--from`/`--terminal` names either the acting caller or a target, and only the spec can
  // say which. An agent session refuses a caller flag naming anyone else before dispatch.
  identityFlagRoles?: Partial<Record<IdentityFlag, 'caller' | 'target'>>
}

export type IdentityFlag = 'from' | 'terminal'

export function specPaths(spec: CommandSpec): string[][] {
  return spec.aliases ? [spec.path, ...spec.aliases] : [spec.path]
}
