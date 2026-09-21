import { afterEach, describe, expect, it, vi } from 'vitest'
import { MALFORMED_CURSOR_MESSAGE, SEARCH_HANDLERS } from './search'
import { AiVaultSearchResponseSchema } from '../../shared/ai-vault-search-contract'
import type { AiVaultSearchResponse, AiVaultSearchStatus } from '../../shared/ai-vault-search-types'
import { REPEATED_FLAG_SEPARATOR } from '../args'
import { RuntimeClientError } from '../runtime/types'

afterEach(() => vi.restoreAllMocks())

const hit = {
  agent: 'claude' as const,
  executionHostId: 'ssh:build-01',
  sessionId: 'session-1',
  title: 'Terminal resize race',
  cwd: '/src/orca',
  branch: 'main',
  updatedAt: '2026-09-12T18:04:11.000Z',
  messageCount: 214,
  score: 12.5,
  evidence: {
    snippet: 'the [[resize]] handler drops the first event',
    role: 'assistant' as const,
    timestamp: '2026-09-12T18:04:11.000Z'
  },
  source: { presence: 'present' as const, filePath: '/transcripts/session-1.jsonl' },
  resumeCommand: 'claude --resume session-1'
}

const resultsResponse: AiVaultSearchResponse = {
  kind: 'results',
  hits: [hit],
  page: { cursor: 'eyJ2IjoxfQ', hasMore: true },
  generation: 42,
  truncated: { candidates: false, snippets: 0, query: false, freshness: false },
  durationMs: 18
}

const statusResponse: AiVaultSearchStatus = {
  enabled: true,
  phase: 'current',
  filesIndexed: 12,
  filesDue: 0,
  filesFailed: 0,
  degradedRoots: [],
  lastReconcileAt: 1789000000000,
  lastSweepCompletedAt: 1789000000000,
  generation: 42
}

function envelope(result: unknown) {
  return { id: 'request-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

async function runSearch(
  flags: [string, string | boolean][],
  options: {
    result?: unknown
    error?: unknown
    json?: boolean
    isRemote?: boolean
  } = {}
): Promise<{ call: ReturnType<typeof vi.fn>; output: string }> {
  const call = options.error
    ? vi.fn().mockRejectedValue(options.error)
    : vi.fn().mockResolvedValue(envelope(options.result ?? resultsResponse))
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => {
    lines.push(String(value))
  })
  await SEARCH_HANDLERS.search!({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only `call` and `isRemote`; a real RuntimeClient would resolve runtime metadata and open a socket.
    client: { call, isRemote: options.isRemote ?? false } as never,
    cwd: '/workspace',
    flags: new Map(flags),
    json: options.json ?? false
  })
  return { call, output: lines.join('\n') }
}

type CliFlags = [string, string | boolean][]

/** The printed envelope, narrowed by shape rather than asserted. */
function printedEnvelope(output: string): { keys: string[]; result: unknown } {
  const parsed: unknown = JSON.parse(output)
  if (typeof parsed !== 'object' || parsed === null || !('result' in parsed)) {
    throw new Error(`Not an RPC envelope: ${output}`)
  }
  return { keys: Object.keys(parsed), result: parsed.result }
}

/** Re-reads the printed result through the contract, so the shape is checked, not claimed. */
function printedResults(output: string): Extract<AiVaultSearchResponse, { kind: 'results' }> {
  const parsed = AiVaultSearchResponseSchema.parse(printedEnvelope(output).result)
  if (parsed.kind !== 'results') {
    throw new Error(`Expected results, got ${parsed.kind}`)
  }
  return parsed
}

describe('orca search over the runtime RPC', () => {
  it('sends the query with the contract defaults the schema resolves', async () => {
    const { call } = await runSearch([['query', 'resize race']])

    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('aiVault.searchSessions', { query: 'resize race', limit: 20 })
  })

  const flagCases: [string, CliFlags, Record<string, unknown>][] = [
    [
      'scope and freshness',
      [
        ['query', 'q'],
        ['scope', 'conversation'],
        ['fresh', true]
      ],
      { query: 'q', scope: 'conversation', freshness: 'wait-until-current', limit: 20 }
    ],
    [
      'paging',
      [
        ['query', 'q'],
        ['limit', '50'],
        ['cursor', 'eyJ2IjoxfQ']
      ],
      { query: 'q', limit: 50, cursor: 'eyJ2IjoxfQ' }
    ],
    [
      'filters',
      [
        ['query', 'q'],
        ['agent', `claude${REPEATED_FLAG_SEPARATOR}codex`],
        ['path', `/a${REPEATED_FLAG_SEPARATOR}/b`],
        ['since', '2026-08-01T00:00:00Z'],
        ['sort', 'newest']
      ],
      {
        query: 'q',
        limit: 20,
        filters: {
          agents: ['claude', 'codex'],
          scopePaths: ['/a', '/b'],
          since: '2026-08-01T00:00:00Z',
          sort: 'newest'
        }
      }
    ],
    [
      'debug',
      [
        ['query', 'q'],
        ['debug', true]
      ],
      { query: 'q', limit: 20, debug: true }
    ]
  ]

  it.each(flagCases)('sends %s', async (_name, flags, params) => {
    const { call } = await runSearch(flags)

    expect(call).toHaveBeenCalledWith('aiVault.searchSessions', params)
  })

  it('calls the status RPC for --index-status', async () => {
    const { call, output } = await runSearch([['index-status', true]], { result: statusResponse })

    expect(call).toHaveBeenCalledWith('aiVault.searchStatus', {})
    expect(output).toContain('phase: current')
  })

  it('renders a result page as text', async () => {
    const { output } = await runSearch([['query', 'q']])

    expect(output).toBe(
      [
        'Claude  2026-09-12T18:04:11.000Z  Terminal resize race  host=ssh:build-01',
        '    assistant: the [[resize]] handler drops the first event',
        '    resume: claude --resume session-1',
        '',
        '1 result on this page, 18 ms.',
        'more pages: re-run with --cursor eyJ2IjoxfQ'
      ].join('\n')
    )
  })

  it('renders a disabled index as an answer', async () => {
    const { output } = await runSearch([['query', 'q']], {
      result: { kind: 'unavailable', reason: 'disabled' }
    })

    expect(output).toBe('Session search is off on this host.')
  })

  it('renders a stale cursor as guidance to re-run without one', async () => {
    const { output } = await runSearch(
      [
        ['query', 'q'],
        ['cursor', 'eyJ2IjoxfQ']
      ],
      { result: { kind: 'stale-cursor', generation: 7, expectedGeneration: 8 } }
    )

    expect(output).toContain('Re-run the same search without --cursor')
  })

  it('raises a malformed cursor through the CLI error channel', async () => {
    await expect(
      runSearch(
        [
          ['query', 'q'],
          ['cursor', 'nope']
        ],
        { result: { kind: 'malformed-cursor' } }
      )
    ).rejects.toThrow(MALFORMED_CURSOR_MESSAGE)
  })

  it('answers a host with no such method as unavailable rather than a raw error', async () => {
    const { output } = await runSearch([['query', 'q']], {
      error: new RuntimeClientError('method_not_found', 'Unknown method aiVault.searchSessions')
    })

    expect(output).toContain('This host runs no session search service.')
  })

  it('answers an old host asked for status with the absent-service sentinel', async () => {
    const { output } = await runSearch([['index-status', true]], {
      error: new RuntimeClientError('method_not_found', 'Unknown method aiVault.searchStatus')
    })

    expect(output).toContain('enabled: false')
    expect(output).toContain('phase: idle')
  })

  it('propagates a transport failure instead of calling it unavailable', async () => {
    await expect(
      runSearch([['query', 'q']], {
        error: new RuntimeClientError('runtime_unavailable', 'Orca is not running.')
      })
    ).rejects.toThrow('Orca is not running.')
  })

  it('applies the paired-client exposure policy for a remote runtime', async () => {
    const { output } = await runSearch([['query', 'q']], { isRemote: true, json: true })

    expect(printedResults(output).hits[0]).not.toHaveProperty('resumeCommand')
    expect(printedResults(output).hits[0]?.source).toEqual({ presence: 'present' })
  })

  it('keeps the local resume command and source path for a same-machine host', async () => {
    const { output } = await runSearch([['query', 'q']], { json: true })

    expect(printedResults(output).hits[0]?.resumeCommand).toBe('claude --resume session-1')
    expect(printedResults(output).hits[0]?.source).toEqual({
      presence: 'present',
      filePath: '/transcripts/session-1.jsonl'
    })
  })
})

describe('orca search --json', () => {
  it('hands back the contract response unchanged under the CLI envelope', async () => {
    const { output } = await runSearch([['query', 'q']], { json: true })
    const printed = printedEnvelope(output)

    expect(printed.keys).toEqual(['id', 'ok', 'result', '_meta'])
    expect(printed.result).toEqual(resultsResponse)
    expect(JSON.stringify(printed.result)).toBe(JSON.stringify(resultsResponse))
  })

  it('drops the debug block the caller did not ask for', async () => {
    const withDebug = {
      ...resultsResponse,
      debug: {
        route: 'phrase' as const,
        plannerReport: { route: 'phrase' as const, scope: 'all' as const }
      }
    }
    const { output } = await runSearch([['query', 'q']], { json: true, result: withDebug })

    expect(printedEnvelope(output).result).not.toHaveProperty('debug')
  })

  it('keeps the debug block the caller asked for', async () => {
    const withDebug = {
      ...resultsResponse,
      debug: {
        route: 'phrase' as const,
        plannerReport: { route: 'phrase' as const, scope: 'all' as const }
      }
    }
    const { output } = await runSearch(
      [
        ['query', 'q'],
        ['debug', true]
      ],
      { json: true, result: withDebug }
    )

    expect(printedResults(output).debug).toEqual(withDebug.debug)
  })

  it('hands back the status response unchanged', async () => {
    const { output } = await runSearch([['index-status', true]], {
      json: true,
      result: statusResponse
    })

    expect(printedEnvelope(output).result).toEqual(statusResponse)
  })
})
