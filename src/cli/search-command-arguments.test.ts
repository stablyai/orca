import { describe, expect, it } from 'vitest'
import {
  normalizeCommandPositionals,
  parseArgs,
  specPaths,
  validateCommandAndFlags,
  type ParsedArgs
} from './args'
import { parseSearchCommand } from './search-command-arguments'
import { COMMAND_SPECS } from './specs'

const COMMAND_PATHS = COMMAND_SPECS.flatMap((spec) => specPaths(spec))

/** The real registry pipeline, so these assertions cover the shipped spec too. */
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

describe('orca search argument parsing', () => {
  it('takes the query positionally', () => {
    expect(parseCli(['search', 'resize race']).commandPath).toEqual(['search'])
    expect(request(['search', 'resize race'])).toEqual({ query: 'resize race' })
  })

  it('takes the query as --query', () => {
    expect(request(['search', '--query', 'resize race'])).toEqual({ query: 'resize race' })
  })

  it('refuses the query given both ways', () => {
    expect(() => parseCli(['search', 'one', '--query', 'two'])).toThrow(
      'Pass --query either positionally or as a flag, not both.'
    )
  })

  it('refuses a search with no query', () => {
    expect(() => parseSearch(['search'])).toThrow('Missing a search query')
  })

  it('maps every flag onto the contract request', () => {
    expect(
      request([
        'search',
        'kernel panic',
        '--scope',
        'conversation',
        '--fresh',
        '--limit',
        '50',
        '--cursor',
        'eyJ2IjoxfQ',
        '--agent',
        'claude',
        '--agent',
        'codex',
        '--path',
        '/Users/me/orca',
        '--path',
        'C:\\src\\orca',
        '--since',
        '2026-08-01T00:00:00Z',
        '--sort',
        'newest',
        '--debug'
      ])
    ).toEqual({
      query: 'kernel panic',
      scope: 'conversation',
      freshness: 'wait-until-current',
      limit: 50,
      cursor: 'eyJ2IjoxfQ',
      filters: {
        agents: ['claude', 'codex'],
        scopePaths: ['/Users/me/orca', 'C:\\src\\orca'],
        since: '2026-08-01T00:00:00Z',
        sort: 'newest'
      },
      debug: true
    })
  })

  it('omits every optional field the caller did not name', () => {
    expect(Object.keys(request(['search', 'q']))).toEqual(['query'])
  })

  it('reads --scope all and --sort relevance', () => {
    expect(request(['search', 'q', '--scope', 'all', '--sort', 'relevance'])).toMatchObject({
      scope: 'all',
      filters: { sort: 'relevance' }
    })
  })

  it('accepts --flag=value for a repeated flag', () => {
    expect(request(['search', 'q', '--path=/a', '--path=/b'])).toMatchObject({
      filters: { scopePaths: ['/a', '/b'] }
    })
  })

  it('rejects an unsupported --scope', () => {
    expect(() => parseSearch(['search', 'q', '--scope', 'files'])).toThrow(
      'Unsupported --scope "files". Use conversation or all.'
    )
  })

  it('rejects an unsupported --sort', () => {
    expect(() => parseSearch(['search', 'q', '--sort', 'oldest'])).toThrow(
      'Unsupported --sort "oldest". Use relevance or newest.'
    )
  })

  it('rejects an unknown --agent and names the known ones', () => {
    expect(() => parseSearch(['search', 'q', '--agent', 'claude', '--agent', 'bogus'])).toThrow(
      /Unknown --agent "bogus"\. Known agents: claude, codex, /
    )
  })

  it('rejects more --path values than the contract accepts', () => {
    const paths = Array.from({ length: 65 }, (_, index) => ['--path', `/p${index}`]).flat()
    expect(() => parseSearch(['search', 'q', ...paths])).toThrow('Too many --path values (65)')
  })

  it('accepts the maximum number of --path values', () => {
    const paths = Array.from({ length: 64 }, (_, index) => ['--path', `/p${index}`]).flat()
    expect(request(['search', 'q', ...paths]).filters?.scopePaths).toHaveLength(64)
  })

  it('rejects a --since without an offset', () => {
    expect(() => parseSearch(['search', 'q', '--since', '2026-08-01'])).toThrow(
      'Invalid --since "2026-08-01"'
    )
  })

  it.each([
    ['--limit', '0'],
    ['--limit', '-1'],
    ['--limit', '1.5'],
    ['--limit', 'many']
  ])('rejects %s %s', (flag, value) => {
    expect(() => parseSearch(['search', 'q', flag, value])).toThrow(/--limit/)
  })

  it('rejects a valueless --cursor', () => {
    expect(() => parseSearch(['search', 'q', '--cursor', '--json'])).toThrow(
      '--cursor requires a value; it was passed with none.'
    )
  })

  it('rejects an unknown flag against the live registry', () => {
    expect(() => parseCli(['search', 'q', '--tier', 'fast'])).toThrow(
      'Unknown flag --tier for command: search'
    )
  })

  it('does not accept the browser --page flag', () => {
    expect(() => parseCli(['search', 'q', '--page', 'page_1'])).toThrow(
      'Unknown flag --page for command: search'
    )
  })
})

describe('orca search --index-status', () => {
  it('asks for the index report', () => {
    expect(parseSearch(['search', '--index-status'])).toEqual({ kind: 'index-status' })
  })

  it.each([
    [['search', 'q', '--index-status'], '--query'],
    [['search', '--index-status', '--limit', '5'], '--limit'],
    [['search', '--index-status', '--fresh'], '--fresh'],
    [['search', '--index-status', '--agent', 'claude'], '--agent']
  ])('refuses %j because it also names %s', (argv, flag) => {
    expect(() => parseSearch(argv)).toThrow(
      `--index-status reports on the index and takes no query, so it cannot be combined with ${flag}.`
    )
  })
})

describe('repeatable flags are command-scoped', () => {
  it('repeats --agent for search', () => {
    expect(request(['search', 'q', '--agent', 'claude', '--agent', 'codex'])).toMatchObject({
      filters: { agents: ['claude', 'codex'] }
    })
  })

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

  it('leaves --agent single-valued for worktree create', () => {
    const parsed = parseCli([
      'worktree',
      'create',
      '--name',
      'w',
      '--agent',
      'claude',
      '--agent',
      'codex'
    ])
    expect(parsed.flags.get('agent')).toBe('codex')
  })

  it('leaves --path single-valued for repo add', () => {
    expect(parseCli(['repo', 'add', '--path', '/a', '--path', '/b']).flags.get('path')).toBe('/b')
  })
})
