export type CommandSpec = {
  path: string[]
  aliases?: string[][]
  /** Old spellings: accepted as input, canonicalized to `path`, and never shown. */
  legacyAliases?: string[][]
  argumentMode?: 'parsed' | 'passthrough'
  // Prevent typo recovery from suggesting destructive actions for unrelated commands.
  destructive?: boolean
  hidden?: boolean
  summary: string
  usage: string
  allowedFlags: string[]
  // Flag repeatability varies by command, even for the same flag name.
  repeatableFlags?: string[]
  positionalArgs?: string[]
  variadicPositional?: boolean
  examples?: string[]
  notes?: string[]
  // Takes `--page <browserPageId>`; only the browser spec modules set it.
  browserPageTarget?: boolean
  // Caller flags must match the acting agent session; target flags may name another session.
  identityFlagRoles?: Partial<Record<IdentityFlag, 'caller' | 'target'>>
}

export type IdentityFlag = 'from' | 'terminal'

/** Still parsed for old scripts, but never offered in help or typo recovery. */
export const INPUT_ONLY_FLAGS: ReadonlySet<string> = new Set(['host'])

export function specPaths(spec: CommandSpec): string[][] {
  return [spec.path, ...(spec.aliases ?? []), ...(spec.legacyAliases ?? [])]
}
