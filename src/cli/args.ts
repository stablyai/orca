import { RuntimeClientError } from './runtime-client'

export type ParsedArgs = {
  commandPath: string[]
  flags: Map<string, string | boolean>
}

export type CommandSpec = {
  path: string[]
  summary: string
  usage: string
  allowedFlags: string[]
  examples?: string[]
  notes?: string[]
}

export const GLOBAL_FLAGS = ['help', 'json']

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
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
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
  if (['repo', 'worktree', 'terminal'].includes(commandPath[0])) {
    return false
  }
  return !['tab list', 'tab create'].includes(joined)
}

export function isCommandGroup(commandPath: string[]): boolean {
  return (
    (commandPath.length === 1 &&
      [
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
        'storage'
      ].includes(commandPath[0])) ||
    (commandPath.length === 2 &&
      commandPath[0] === 'storage' &&
      ['local', 'session'].includes(commandPath[1]))
  )
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
