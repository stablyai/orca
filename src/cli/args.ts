import { RuntimeClientError } from './runtime/types'
import { unknownCommandData, unknownFlagData } from './command-suggestion'
import { specPaths, type CommandSpec } from './command-spec'
import {
  CLI_BOOLEAN_FLAGS,
  CLI_GLOBAL_FLAGS,
  CLI_GLOBAL_VALUE_FLAGS,
  findCliCommandIndex
} from '../shared/cli-argument-boundary'

export { specPaths }
export type { CommandSpec }

export type ParsedArgs = {
  commandPath: string[]
  flags: Map<string, string | boolean>
  positionalFlagConflicts?: string[]
}

export const GLOBAL_FLAGS = CLI_GLOBAL_FLAGS
const GLOBAL_VALUE_FLAGS = new Set(CLI_GLOBAL_VALUE_FLAGS)
/** Global flags a local-only command offers; it still accepts the remote selectors, only to refuse them. */
export const LOCAL_COMMAND_FLAGS = GLOBAL_FLAGS.filter((flag) => !GLOBAL_VALUE_FLAGS.has(flag))
export const BOOLEAN_FLAGS = CLI_BOOLEAN_FLAGS

export const REPEATED_FLAG_SEPARATOR = '\u0000'
const REPEATABLE_STRING_FLAGS = new Set(['label', 'skill'])

function setFlagValue(
  flags: Map<string, string | boolean>,
  name: string,
  value: string,
  repeatable: ReadonlySet<string>
): void {
  const existing = flags.get(name)
  if (typeof existing === 'string' && repeatable.has(name)) {
    flags.set(name, `${existing}${REPEATED_FLAG_SEPARATOR}${value}`)
    return
  }
  flags.set(name, value)
}

// Prefer the longest path so command groups cannot shadow leaf commands.
function specForPathPrefix(
  specs: readonly CommandSpec[],
  path: readonly string[]
): CommandSpec | undefined {
  let best: { spec: CommandSpec; length: number } | undefined
  for (const spec of specs) {
    for (const candidate of specPaths(spec)) {
      if (
        candidate.length <= path.length &&
        candidate.every((part, index) => part === path[index]) &&
        (!best || candidate.length > best.length)
      ) {
        best = { spec, length: candidate.length }
      }
    }
  }
  return best?.spec
}

export function parseArgs(
  argv: string[],
  commandPaths?: readonly string[][],
  specs: readonly CommandSpec[] = []
): ParsedArgs {
  const commandPath: string[] = []
  const flagEntries: [string, string | boolean][] = []
  const commandIndex = findCliCommandIndex(argv, commandPaths ?? [])

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      commandPath.push(token)
      continue
    }

    const assignment = token.slice(2)
    // --flag=value permits values starting with -- without treating them as another flag.
    const equalsIndex = assignment.indexOf('=')
    if (equalsIndex !== -1) {
      flagEntries.push([assignment.slice(0, equalsIndex), assignment.slice(equalsIndex + 1)])
      continue
    }

    const flag = assignment
    if (BOOLEAN_FLAGS.has(flag)) {
      flagEntries.push([flag, true])
      continue
    }
    // Pre-command flags must not consume a registered command path.
    if (commandPath.length === 0 && i + 1 === commandIndex) {
      flagEntries.push([flag, true])
      continue
    }
    const hasNext = i + 1 < argv.length
    const next = argv[i + 1]
    if (!hasNext || next.startsWith('--')) {
      flagEntries.push([flag, true])
      continue
    }
    flagEntries.push([flag, next])
    i += 1
  }

  const declared = specForPathPrefix(specs, commandPath)?.repeatableFlags
  const repeatable = declared
    ? new Set([...REPEATABLE_STRING_FLAGS, ...declared])
    : REPEATABLE_STRING_FLAGS
  const flags = new Map<string, string | boolean>()
  for (const [name, value] of flagEntries) {
    if (typeof value === 'string') {
      setFlagValue(flags, name, value, repeatable)
    } else {
      flags.set(name, value)
    }
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

export function supportsBrowserPageFlag(spec: Pick<CommandSpec, 'browserPageTarget'>): boolean {
  return spec.browserPageTarget === true
}

export function effectiveAllowedFlags(spec: CommandSpec): string[] {
  if (spec.argumentMode === 'passthrough') {
    return []
  }
  return [
    ...new Set([
      ...GLOBAL_FLAGS,
      ...spec.allowedFlags,
      ...(supportsBrowserPageFlag(spec) ? ['page'] : [])
    ])
  ]
}

export function isCommandGroup(specs: CommandSpec[], commandPath: string[]): boolean {
  if (commandPath.length === 0) {
    return false
  }
  return specs.some(
    (spec) =>
      spec.hidden !== true &&
      specPaths(spec).some(
        (candidate) =>
          candidate.length > commandPath.length &&
          matches(candidate.slice(0, commandPath.length), commandPath)
      )
  )
}

export function normalizeCommandPositionals(specs: CommandSpec[], parsed: ParsedArgs): ParsedArgs {
  for (const spec of specs) {
    const positionalArgs = spec.positionalArgs ?? []
    // Alias-only paths still need canonicalization without positional arguments.
    if (positionalArgs.length === 0 && !spec.aliases) {
      continue
    }
    for (const base of specPaths(spec)) {
      // Zero positionals still permit an exact alias match.
      const positionalCount = parsed.commandPath.length - base.length
      if (
        positionalCount < 0 ||
        (!spec.variadicPositional && positionalCount > positionalArgs.length)
      ) {
        continue
      }
      if (!matches(parsed.commandPath.slice(0, base.length), base)) {
        continue
      }
      const flags = new Map(parsed.flags)
      const values = parsed.commandPath.slice(base.length)
      // Record ambiguity here; validation reports it through the CLI error formatter.
      const providedPositionals = values.map(
        (_, index) => positionalArgs[Math.min(index, positionalArgs.length - 1)]
      )
      const positionalFlagConflicts = providedPositionals.filter((name) => flags.has(name))
      values.forEach((value, index) => {
        const name = providedPositionals[index]
        if (!parsed.flags.has(name)) {
          setFlagValue(flags, name, value, new Set(spec.repeatableFlags ?? []))
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

  const pageAllowed = supportsBrowserPageFlag(spec)
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
