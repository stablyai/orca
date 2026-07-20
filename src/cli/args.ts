import { RuntimeClientError } from './runtime-client'
import { unknownCommandData, unknownFlagData } from './command-suggestion'
import {
  GLOBAL_FLAGS,
  GLOBAL_VALUE_FLAGS,
  matches,
  type ParsedArgs
} from '../shared/cli-args-parser'

export {
  BOOLEAN_FLAGS,
  GLOBAL_FLAGS,
  REPEATED_FLAG_SEPARATOR,
  matches,
  parseArgs,
  type ParsedArgs
} from '../shared/cli-args-parser'

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

export function resolveHelpPath(parsed: ParsedArgs): string[] | null {
  if (parsed.commandPath[0] === 'help') {
    return parsed.commandPath.slice(1)
  }
  if (parsed.flags.has('help')) {
    return parsed.commandPath
  }
  return null
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
      'skills',
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
        'skills',
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
