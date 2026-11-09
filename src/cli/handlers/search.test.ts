import { afterEach, describe, expect, it, vi } from 'vitest'
import { SEARCH_HANDLERS } from './search'
import type {
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../shared/ai-vault/search/ai-vault-search-types'
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
})
