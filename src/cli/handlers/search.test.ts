import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SEARCH_HANDLERS } from './search'
import { REPEATED_FLAG_SEPARATOR } from '../args'
import { RuntimeClientError } from '../runtime/types'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import type { AiVaultSearchResult } from '../../shared/ai-vault-search-types'

const RESULT: AiVaultSearchResult = {
  hits: [],
  route: 'and',
  durationMs: 7,
  coverage: {
    sessionsIndexed: 12,
    messagesIndexed: 340,
    providers: [],
    backfill: 'complete',
    filesPending: 0,
    lastIndexedAt: '2026-08-30T00:00:00.000Z'
  }
}

const callMock = vi.fn()
let logSpy: ReturnType<typeof vi.spyOn>

function repeated(...values: string[]): string {
  return values.join(REPEATED_FLAG_SEPARATOR)
}

function runSearch(
  flags: Record<string, string | boolean>,
  options: { json?: boolean; cwd?: string } = {}
): Promise<void> {
  const ctx: HandlerContext = {
    flags: new Map(Object.entries(flags)),
    client: { call: callMock } as unknown as RuntimeClient,
    cwd: options.cwd ?? '/home/user/repo',
    json: options.json ?? false
  }
  return SEARCH_HANDLERS.search(ctx)
}

function searchParams(): Record<string, unknown> {
  return callMock.mock.calls[0]?.[1] as Record<string, unknown>
}

beforeEach(() => {
  callMock.mockReset()
  callMock.mockResolvedValue({ id: 'r1', ok: true, result: RESULT, _meta: { runtimeId: 'rt' } })
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('orca search --agent-session', () => {
  it('requires the query flag and never calls the runtime without it', async () => {
    await expect(runSearch({})).rejects.toThrow(RuntimeClientError)
    await expect(runSearch({})).rejects.toThrow(/Missing --agent-session/)
    await expect(runSearch({ 'agent-session': '' })).rejects.toThrow(/Missing --agent-session/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('reports invalid_argument for the missing query', async () => {
    const error = await runSearch({}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RuntimeClientError)
    expect((error as RuntimeClientError).code).toBe('invalid_argument')
  })

  it('sends the query with relevance sort by default', async () => {
    await runSearch({ 'agent-session': 'strict mode violation' })

    expect(callMock).toHaveBeenCalledWith('aiVault.searchSessions', expect.any(Object))
    expect(searchParams()).toMatchObject({ query: 'strict mode violation', sort: 'relevance' })
    expect(searchParams().executionHostId).toBeUndefined()
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('maps --newest to the newest sort', async () => {
    await runSearch({ 'agent-session': 'q', newest: true })
    expect(searchParams().sort).toBe('newest')
  })

  it('rejects an unknown --agent before calling the runtime', async () => {
    const error = await runSearch({ 'agent-session': 'q', agent: 'clod' }).catch(
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(RuntimeClientError)
    expect((error as RuntimeClientError).code).toBe('invalid_argument')
    expect((error as Error).message).toMatch(/Unknown --agent clod/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('collects repeated --agent and --path into arrays', async () => {
    await runSearch({
      'agent-session': 'q',
      agent: repeated('claude', 'CODEX'),
      path: repeated('/a', '/b')
    })

    expect(searchParams()).toMatchObject({
      agents: ['claude', 'codex'],
      scopePaths: ['/a', '/b']
    })
  })

  it('expands a leading ~ in --path against HOME', async () => {
    vi.stubEnv('HOME', '/home/tester')
    await runSearch({ 'agent-session': 'q', path: '~/orca' })
    expect(searchParams().scopePaths).toEqual(['/home/tester/orca'])
    vi.unstubAllEnvs()
  })

  it('omits agents and scopePaths when neither flag is given', async () => {
    await runSearch({ 'agent-session': 'q' })
    expect(searchParams().agents).toBeUndefined()
    expect(searchParams().scopePaths).toBeUndefined()
  })

  it('rejects a --since that is not a timestamp', async () => {
    const error = await runSearch({ 'agent-session': 'q', since: 'last tuesday' }).catch(
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(RuntimeClientError)
    expect((error as RuntimeClientError).code).toBe('invalid_argument')
    expect((error as Error).message).toMatch(/ISO 8601/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('normalizes --since to an ISO timestamp', async () => {
    await runSearch({ 'agent-session': 'q', since: '2026-08-01T00:00:00+02:00' })
    expect(searchParams().since).toBe('2026-07-31T22:00:00.000Z')
  })

  it('rejects an ssh host because the index lives with the transcripts', async () => {
    const error = await runSearch({ 'agent-session': 'q', host: 'ssh:dev-box' }).catch(
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(RuntimeClientError)
    expect((error as RuntimeClientError).code).toBe('invalid_argument')
    expect((error as Error).message).toMatch(/runtime host/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('forwards a runtime host id', async () => {
    await runSearch({ 'agent-session': 'q', host: 'runtime:env-1' })
    expect(searchParams().executionHostId).toBe('runtime:env-1')
  })

  it('rejects an unparseable --host', async () => {
    await expect(runSearch({ 'agent-session': 'q', host: 'nonsense' })).rejects.toThrow(
      /Invalid --host/
    )
    expect(callMock).not.toHaveBeenCalled()
  })

  it('prints the raw envelope under --json', async () => {
    await runSearch({ 'agent-session': 'q' }, { json: true })

    const printed = logSpy.mock.calls[0]?.[0] as string
    expect(JSON.parse(printed)).toEqual({
      id: 'r1',
      ok: true,
      result: RESULT,
      _meta: { runtimeId: 'rt' }
    })
  })

  it('prints the human summary when --json is not set', async () => {
    await runSearch({ 'agent-session': 'nothing here' })

    const printed = logSpy.mock.calls[0]?.[0] as string
    expect(printed).toContain('No sessions match "nothing here".')
    expect(printed).toContain('12 sessions indexed')
  })
})
