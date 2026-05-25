import { RuntimeClientError } from './runtime-client'

export type ParsedArgs = {
  commandPath: string[]
  flags: Map<string, string | boolean>
  positionalFlagConflicts?: string[]
}

export type CommandSpec = {
  path: string[]
  summary: string
  usage: string
  allowedFlags: string[]
  positionalArgs?: string[]
  examples?: string[]
  notes?: string[]
}

export const GLOBAL_FLAGS = ['help', 'json', 'pairing-code', 'environment']

export function parseArgs(argv: string[]): ParsedArgs {
  const commandPath: string[] = []
  const flags = new Map<string, string | boolean>()

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      commandPath.push(token)
      continue
    }

    const flag = token.slice(2)
    const hasNext = i + 1 < argv.length
    const next = argv[i + 1]
    if (!hasNext || next.startsWith('--')) {
      flags.set(flag, true)
      continue
    }
    flags.set(flag, next)
    i += 1
  }

  return { commandPath, flags }
}

export function resolveHelpPath(parsed: ParsedArgs): string[] | null {
  if (parsed.commandPath[0] === 'help') {
    return parsed.commandPath.slice(1)
  }
  if (parsed.flags.has('help')) {
    return parsed.commandPath
  }
  return null
}

export function matches(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  )
}

export function supportsBrowserPageFlag(commandPath: string[]): boolean {
  const joined = commandPath.join(' ')
  if (['open', 'status'].includes(commandPath[0])) {
    return false
  }
  if (
    ['automations', 'repo', 'worktree', 'terminal', 'computer', 'note'].includes(commandPath[0])
  ) {
    return false
  }
  return ![
    'tab list',
    'tab create',
    'tab current',
    'tab profile list',
    'tab profile create',
    'tab profile delete'
  ].includes(joined)
}

export function isCommandGroup(commandPath: string[]): boolean {
  return (
    (commandPath.length === 1 &&
      [
        'automations',
        'repo',
        'worktree',
        'terminal',
        'tab',
        'cookie',
        'intercept',
        'capture',
        'mouse',
        'set',
        'clipboard',
        'dialog',
        'storage',
        'orchestration',
        'computer',
        'environment'
      ].includes(commandPath[0])) ||
    (commandPath.length === 2 &&
      commandPath[0] === 'storage' &&
      ['local', 'session'].includes(commandPath[1]))
  )
}

export function normalizeCommandPositionals(specs: CommandSpec[], parsed: ParsedArgs): ParsedArgs {
  for (const spec of specs) {
    const positionalArgs = spec.positionalArgs ?? []
    if (positionalArgs.length === 0) {
      continue
    }
    if (parsed.commandPath.length !== spec.path.length + positionalArgs.length) {
      continue
    }
    if (!matches(parsed.commandPath.slice(0, spec.path.length), spec.path)) {
      continue
    }
    const flags = new Map(parsed.flags)
    const values = parsed.commandPath.slice(spec.path.length)
    // Why: validation runs inside main's error-reporting path, so normalization
    // records ambiguity instead of throwing before CLI errors can be formatted.
    const positionalFlagConflicts = positionalArgs.filter((name) => flags.has(name))
    positionalArgs.forEach((name, index) => {
      if (!flags.has(name)) {
        flags.set(name, values[index])
      }
    })
    return { commandPath: spec.path, flags, positionalFlagConflicts }
  }
  return parsed
}

export function findCommandSpec(
  specs: CommandSpec[],
  commandPath: string[]
): CommandSpec | undefined {
  return specs.find((spec) => matches(spec.path, commandPath))
}

export function validateCommandAndFlags(specs: CommandSpec[], parsed: ParsedArgs): void {
  const spec = findCommandSpec(specs, parsed.commandPath)
  if (!spec) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown command: ${parsed.commandPath.join(' ')}`
    )
  }

  if (parsed.positionalFlagConflicts && parsed.positionalFlagConflicts.length > 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Pass ${parsed.positionalFlagConflicts
        .map((flag) => `--${flag}`)
        .join(', ')} either positionally or as a flag, not both.`
    )
  }

  for (const flag of parsed.flags.keys()) {
    if (
      !spec.allowedFlags.includes(flag) &&
      !(flag === 'page' && supportsBrowserPageFlag(spec.path))
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown flag --${flag} for command: ${spec.path.join(' ')}`
      )
    }
  }
}
