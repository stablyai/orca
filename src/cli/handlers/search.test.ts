import { afterEach, describe, expect, it, vi } from 'vitest'
import { SEARCH_HANDLERS } from './search'
import { AiVaultSearchResponseSchema } from '../../shared/ai-vault-search-contract'
import type { AiVaultSearchResponse, AiVaultSearchStatus } from '../../shared/ai-vault-search-types'
import { RuntimeClientError } from '../runtime/types'
import { RuntimeClient } from '../runtime-client'
import { okFixture } from '../test-fixtures'

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
    : vi
        .fn()
        .mockImplementation((method: string) =>
          Promise.resolve(
            okFixture(
              'request-1',
              method === 'aiVault.searchStatus'
                ? statusResponse
                : (options.result ?? resultsResponse)
            )
          )
        )
  const lines: string[] = []
  const client = new RuntimeClient('/tmp/orca-search-test', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(call)
  vi.spyOn(client, 'isRemote', 'get').mockReturnValue(options.isRemote ?? false)
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => {
    lines.push(String(value))
  })
  await SEARCH_HANDLERS.search!({
    client,
    cwd: '/workspace',
    flags: new Map(flags),
    json: options.json ?? false
  })
  return { call, output: lines.join('\n') }
}

function printedEnvelope(output: string): { keys: string[]; result: unknown } {
  const parsed: unknown = JSON.parse(output)
  if (typeof parsed !== 'object' || parsed === null || !('result' in parsed)) {
    throw new Error(`Not an RPC envelope: ${output}`)
  }
  return { keys: Object.keys(parsed), result: parsed.result }
}

function printedResults(output: string): Extract<AiVaultSearchResponse, { kind: 'results' }> {
  const parsed = AiVaultSearchResponseSchema.parse(printedEnvelope(output).result)
  if (parsed.kind !== 'results') {
    throw new Error(`Expected results, got ${parsed.kind}`)
  }
  return parsed
}

describe('orca search over the runtime RPC', () => {
  it('raises a malformed cursor through the CLI error channel', async () => {
    await expect(
      runSearch(
        [
          ['query', 'q'],
          ['cursor', 'nope']
        ],
        { result: { kind: 'malformed-cursor' } }
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('re-run the search without --cursor')
    })
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
})
