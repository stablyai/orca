export type CommandSpec = {
  path: string[]
  // Why: conventional alternate verbs should resolve without duplicating specs or handlers.
  aliases?: string[][]
  argumentMode?: 'parsed' | 'passthrough'
  // Why: typo recovery must never steer a benign mistake into destructive state changes.
  destructive?: boolean
  summary: string
  usage: string
  allowedFlags: string[]
  // Why: repeatability is per command — a globally repeatable flag would silently
  // change every other command that reads the same flag name as a single value.
  repeatableFlags?: readonly string[]
  positionalArgs?: string[]
  examples?: string[]
  notes?: string[]
}

export function specPaths(spec: CommandSpec): string[][] {
  return spec.aliases ? [spec.path, ...spec.aliases] : [spec.path]
}
