import { describe, expect, it } from 'vitest'
import {
  normalizeCommandPositionals,
  parseArgs,
  validateCommandAndFlags,
  type ParsedArgs
} from '../args'
import { specPaths } from '../command-spec'
import { parseSearchCommand } from './search-command-arguments'
import { COMMAND_SPECS } from '../specs/index'

const COMMAND_PATHS = COMMAND_SPECS.flatMap((spec) => specPaths(spec))

function parseCli(argv: string[]): ParsedArgs {
  const parsed = normalizeCommandPositionals(
    COMMAND_SPECS,
    parseArgs(argv, COMMAND_PATHS, COMMAND_SPECS)
  )
  validateCommandAndFlags(COMMAND_SPECS, parsed)
  return parsed
}

function parseSearch(argv: string[]): ReturnType<typeof parseSearchCommand> {
  return parseSearchCommand(parseCli(argv).flags)
}

function request(argv: string[]) {
  const command = parseSearch(argv)
  if (command.kind !== 'search') {
    throw new Error(`Expected a search, got ${command.kind}`)
  }
  return command.request
}

describe('repeatable flags are command-scoped', () => {
  it('repeats --agent placed before the command', () => {
    expect(request(['--agent', 'claude', '--agent', 'codex', 'search', 'q'])).toMatchObject({
      filters: { agents: ['claude', 'codex'] }
    })
  })

  it('repeats --path across the command boundary', () => {
    expect(request(['--path', '/a', 'search', 'q', '--path', '/b'])).toMatchObject({
      filters: { scopePaths: ['/a', '/b'] }
    })
  })

  it('leaves a pre-command --agent single-valued for worktree create', () => {
    const parsed = parseCli([
      '--agent',
      'claude',
      '--agent',
      'codex',
      'worktree',
      'create',
      '--name',
      'w'
    ])
    expect(parsed.flags.get('agent')).toBe('codex')
  })
})
