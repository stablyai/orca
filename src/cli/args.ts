import { RuntimeClientError } from './runtime-client'
import { unknownCommandData, unknownFlagData } from './command-suggestion'

export type ParsedArgs = {
  commandPath: string[]
  flags: Map<string, string | boolean>
  positionalFlagConflicts?: string[]
}

export type CommandSpec = {
  path: string[]
  // Why: conventional alternate verbs should resolve without duplicating specs
  // or handler registrations.
  aliases?: string[][]
  argumentMode?: 'parsed' | 'passthrough'
  // Why: irreversibly destroys persistent state — typo recovery must not steer a
  // benign mistake into one of these via the agent nextSteps channel. #6303
  destructive?: boolean
  summary: string
  usage: string
  allowedFlags: string[]
  positionalArgs?: string[]
  examples?: string[]
  notes?: string[]
}

export const GLOBAL_FLAGS = ['help', 'json', 'pairing-code', 'environment']
const GLOBAL_VALUE_FLAGS = new Set(['pairing-code', 'environment'])
export const BOOLEAN_FLAGS = new Set([
  'all',
  'attachments',
  'children',
  'comments',
  'connect',
  'current',
  'dry-run',
  'enter',
  'focus',
  'force',
  'full',
  'help',
  'inject',
  'interrupt',
  'json',
  'messages',
  'me',
  'mobile',
  'mobile-pairing',
  'no-pairing',
  'parent-current',
  'provision',
  'ready',
  'recipe-json',
  'relations',
  'reinstall',
  'restore-window',
  'return-preamble',
  'run-hooks',
  'show-profile',
  'staged',
  'tasks',
  'text-stdin',
  'unread',
  'value-stdin',
  'wait'
])

export const REPEATED_FLAG_SEPARATOR = '\u0000'
const REPEATABLE_STRING_FLAGS = new Set(['label'])

function setFlagValue(flags: Map<string, string | boolean>, name: string, value: string): void {
  const existing = flags.get(name)
  if (typeof existing === 'string' && REPEATABLE_STRING_FLAGS.has(name)) {
    flags.set(name, `${existing}${REPEATED_FLAG_SEPARATOR}${value}`)
    return
  }
  flags.set(name, value)
}

function commandPathStartsAt(argv: string[], tokenIndex: number, path: string[]): boolean {
  let cursor = tokenIndex
  for (const part of path) {
    while (argv[cursor]?.startsWith('--')) {
      const assignment = argv[cursor].slice(2)
      const flag = assignment.split('=', 1)[0]
      cursor += assignment.includes('=') || BOOLEAN_FLAGS.has(flag) ? 1 : 2
    }
    if (argv[cursor] !== part) {
      return false
    }
    cursor += 1
  }
  return true
}

export function parseArgs(argv: string[], commandPaths?: readonly string[][]): ParsedArgs {
  const commandPath: string[] = []
  const flags = new Map<string, string | boolean>()

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      commandPath.push(token)
      continue
    }

    const assignment = token.slice(2)
    // Why: `--flag=value` is the only unambiguous way to pass a value that
    // itself starts with `--` (e.g. `--text=--help`); the space-separated form
    // treats a `--`-leading next token as a new flag, so it can't express one.
    const equalsIndex = assignment.indexOf('=')
    if (equalsIndex !== -1) {
      setFlagValue(flags, assignment.slice(0, equalsIndex), assignment.slice(equalsIndex + 1))
      continue
    }

    const flag = assignment
    if (BOOLEAN_FLAGS.has(flag)) {
      flags.set(flag, true)
      continue
    }
    // Why: a pre-command flag must not consume a registry-resolvable command path.
    const startsCommandAt = (tokenIndex: number): boolean =>
      commandPaths?.some((path) => commandPathStartsAt(argv, tokenIndex, path)) ?? false
    if (commandPath.length === 0 && startsCommandAt(i + 1) && !startsCommandAt(i + 2)) {
      flags.set(flag, true)
      continue
    }
    const hasNext = i + 1 < argv.length
    const next = argv[i + 1]
    if (!hasNext || next.startsWith('--')) {
      flags.set(flag, true)
      continue
    }
    setFlagValue(flags, flag, next)
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

// Why: a spec is reachable by its canonical path plus any declared aliases — one
// definition so resolution, validation, help, and agent-context never disagree.
export function specPaths(spec: CommandSpec): string[][] {
  return spec.aliases ? [spec.path, ...spec.aliases] : [spec.path]
}

export function supportsBrowserPageFlag(commandPath: string[]): boolean {
  const joined = commandPath.join(' ')
  if (['open', 'status'].includes(commandPath[0])) {
    return false
  }
  if (
    [
      'automations',
      'project',
      'repo',
      'worktree',
      'terminal',
      'file',
      'orchestration',
      'computer',
      'emulator',
      'note',
      'diagnostics',
      'linear',
      'agent-context'
    ].includes(commandPath[0])
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

// Why: validation and agent discovery must expose the same effective flag set.
export function effectiveAllowedFlags(spec: CommandSpec): string[] {
  if (spec.argumentMode === 'passthrough') {
    return []
  }
  return [
    ...new Set([
      ...GLOBAL_FLAGS,
      ...spec.allowedFlags,
      ...(supportsBrowserPageFlag(spec.path) ? ['page'] : [])
    ])
  ]
}

export function isCommandGroup(commandPath: string[]): boolean {
  return (
    (commandPath.length === 1 &&
      [
        'automations',
        'project',
        'repo',
        'worktree',
        'terminal',
        'file',
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
        'emulator',
        'agent',
        'environment',
        'diagnostics',
        'linear',
        'vm'
      ].includes(commandPath[0])) ||
    (commandPath.length === 2 && commandPath[0] === 'agent' && commandPath[1] === 'hooks') ||
    (commandPath.length === 2 &&
      commandPath[0] === 'storage' &&
      ['local', 'session'].includes(commandPath[1]))
  )
}

export function normalizeCommandPositionals(specs: CommandSpec[], parsed: ParsedArgs): ParsedArgs {
  for (const spec of specs) {
    const positionalArgs = spec.positionalArgs ?? []
    // Why: aliased paths still need canonicalization when there are no positionals.
    if (positionalArgs.length === 0 && !spec.aliases) {
      continue
    }
    // Why: canonicalize aliases before validation and dispatch so both use one key.
    for (const base of specPaths(spec)) {
      // Why: `< 0` (not `<= 0`) so an exact base match with zero positionals
      // still canonicalizes an aliased path; upper bound guards over-consumption.
      const positionalCount = parsed.commandPath.length - base.length
      if (positionalCount < 0 || positionalCount > positionalArgs.length) {
        continue
      }
      if (!matches(parsed.commandPath.slice(0, base.length), base)) {
        continue
      }
      const flags = new Map(parsed.flags)
      const values = parsed.commandPath.slice(base.length)
      // Why: validation runs inside main's error-reporting path, so normalization
      // records ambiguity instead of throwing before CLI errors can be formatted.
      const providedPositionals = values.map((_, index) => positionalArgs[index])
      const positionalFlagConflicts = providedPositionals.filter((name) => flags.has(name))
      values.forEach((value, index) => {
        const name = positionalArgs[index]
        if (!flags.has(name)) {
          flags.set(name, value)
        }
      })
      return { commandPath: spec.path, flags, positionalFlagConflicts }
    }
  }
  return parsed
}

export function findCommandSpec(
  specs: CommandSpec[],
  commandPath: string[]
): CommandSpec | undefined {
  return specs.find((spec) => specPaths(spec).some((candidate) => matches(candidate, commandPath)))
}

export function validateCommandAndFlags(specs: CommandSpec[], parsed: ParsedArgs): void {
  const spec = findCommandSpec(specs, parsed.commandPath)
  if (!spec) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown command: ${parsed.commandPath.join(' ')}`,
      unknownCommandData(specs, parsed.commandPath)
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

  const pageAllowed = supportsBrowserPageFlag(spec.path)
  for (const [flag, value] of parsed.flags) {
    const isGlobalFlag = GLOBAL_FLAGS.includes(flag)
    if (GLOBAL_VALUE_FLAGS.has(flag) && (typeof value !== 'string' || value.length === 0)) {
      throw new RuntimeClientError('invalid_argument', `Flag --${flag} requires a value.`)
    }
    if (!isGlobalFlag && !spec.allowedFlags.includes(flag) && !(flag === 'page' && pageAllowed)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown flag --${flag} for command: ${spec.path.join(' ')}`,
        unknownFlagData(flag, effectiveAllowedFlags(spec))
      )
    }
  }
}
