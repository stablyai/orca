import { afterEach, expect, it, vi } from 'vitest'
import { searchAllHosts } from './session-search-all-hosts'
import { querySearchHost } from './session-search-host-query'
import type { RuntimeClient } from './runtime-client'
import type { AiVaultSearchResult } from '../shared/ai-vault-search-types'

afterEach(() => vi.useRealTimers())
const query = { host: 'all' as const, status: false, query: { query: 'shared phrase' } }
const status = { enabled: true, historyDays: null, indexSizeBytes: 42 }

it('distinguishes a missing SSH route from unknown legacy runtime policy without querying either', async () => {
  const legacy = client('legacy')
  vi.mocked(legacy.call).mockRejectedValue(
    Object.assign(new Error('Method not found'), { code: 'method_not_found' })
  )
  for (const targetId of [undefined, 'ssh-one']) {
    const value = await querySearchHost(
      { id: 'legacy', name: 'Legacy', selector: 'legacy', client: legacy, targetId },
      query,
      true,
      new AbortController().signal
    )
    expect(value.outcome).toBe(targetId ? 'unsupported' : 'policy-unknown')
  }
  expect(vi.mocked(legacy.call).mock.calls.map(([method]) => method)).toEqual([
    'aiVault.searchIndexStatus',
    'aiVault.sshSearchIndexStatus'
  ])
})

function result(owner: string): AiVaultSearchResult {
  return {
    route: 'phrase',
    durationMs: 1,
    coverage: {
      enabled: true,
      sessionsIndexed: 5,
      messagesIndexed: 5,
      providers: [],
      backfill: 'complete',
      filesPending: 0,
      lastIndexedAt: null
    },
    hits: Array.from({ length: 5 }, (_, i) => ({
      agent: 'claude',
      sessionId: String(i),
      title: owner,
      filePath: `/same/${i}.jsonl`,
      codexHome: null,
      cwd: '/same',
      branch: null,
      updatedAt: null,
      messageCount: 1,
      resumeCommand: `claude --resume ${i}`,
      score: i,
      evidence: { role: 'user', timestamp: null, snippet: 'shared phrase' }
    }))
  }
}
function client(owner: string, remote = false) {
  return {
    isRemote: remote,
    call: vi.fn(async (method: string) => ({
      result: method.endsWith('Status') ? status : result(owner)
    }))
  } as unknown as RuntimeClient
}

it('queries at most sixteen routes with no more than three simultaneous host legs', async () => {
  vi.useFakeTimers()
  let active = 0,
    maximum = 0,
    calls = 0
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const local = client('owner')
  vi.mocked(local.call).mockImplementation(async (method) => {
    if (method.endsWith('Status')) {
      return { result: status } as never
    }
    active++
    calls++
    maximum = Math.max(maximum, active)
    await barrier
    active--
    return { result: result('owner') } as never
  })
  const createClient = vi.fn(() => local)
  const pending = searchAllHosts(local, query, new AbortController().signal, Date.now() + 30_000, {
    listEnvironments: () =>
      Array.from({ length: 20 }, (_, i) => ({ id: `env-${i}`, name: `Host ${i}` })),
    listSshTargets: async () => [],
    createClient
  })
  await vi.advanceTimersByTimeAsync(1)
  expect(active).toBe(3)
  release()
  const value = await pending
  expect(maximum).toBe(3)
  expect(calls).toBe(16)
  expect(createClient).toHaveBeenCalledTimes(15)
  expect(value.omittedHosts).toBe(5)
})

it('returns five plus five in separate owner groups despite identical session IDs and paths', async () => {
  const local = client('local')
  const ssh = { id: 'ssh-one', label: 'ssh-one', connected: true }
  const value = await searchAllHosts(
    local,
    query,
    new AbortController().signal,
    Date.now() + 30_000,
    {
      listEnvironments: () => [],
      createClient: () => {
        throw new Error('unexpected pairing')
      },
      listSshTargets: async () => [ssh]
    }
  )
  expect(value.hosts.map((host) => [host.host.id, host.outcome, host.result?.hits.length])).toEqual(
    [
      ['local', 'searched', 5],
      ['ssh:ssh-one', 'searched', 5]
    ]
  )
  expect(value.partial).toBe(false)
  expect(local.call).toHaveBeenCalledWith(
    'aiVault.sshSearchSessions',
    { query: 'shared phrase', targetId: 'ssh-one' },
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  )
})

// The hits from an unverifiable source are in the answer, so nothing is missing
// from the aggregate; the host's own count still reports the caveat.
it('does not call the aggregate partial for a host that only has unverifiable sources', async () => {
  const local = client('local')
  vi.mocked(local.call).mockImplementation((async (method: string) => ({
    result: method.endsWith('Status') ? status : { ...result('local'), sourceUnavailableFiles: 1 }
  })) as unknown as RuntimeClient['call'])
  const value = await searchAllHosts(
    local,
    query,
    new AbortController().signal,
    Date.now() + 30_000,
    { listEnvironments: () => [], createClient: () => local, listSshTargets: async () => [] }
  )

  expect(value.hosts[0]?.outcome).toBe('searched')
  expect(value.hosts[0]?.result?.sourceUnavailableFiles).toBe(1)
  expect(value.partial).toBe(false)
})

it('does not query a legacy host with unknown consent and does not enumerate pairings from a remote context', async () => {
  const remote = client('B', true)
  vi.mocked(remote.call).mockResolvedValue({ result: {} } as never)
  const pairings = vi.fn(() => [])
  const value = await searchAllHosts(
    remote,
    query,
    new AbortController().signal,
    Date.now() + 30_000,
    { listEnvironments: pairings, createClient: () => remote, listSshTargets: async () => [] }
  )
  expect(value.hosts[0]?.outcome).toBe('policy-unknown')
  expect(remote.call).toHaveBeenCalledTimes(1)
  expect(pairings).not.toHaveBeenCalled()
})

it('bounds stalled inventory independently so known host results still complete', async () => {
  vi.useFakeTimers()
  const local = client('local')
  let signal: AbortSignal | undefined
  const pending = searchAllHosts(local, query, new AbortController().signal, Date.now() + 30_000, {
    listEnvironments: () => [],
    createClient: () => local,
    listSshTargets: async (_client, options) => {
      signal = options?.signal
      return new Promise(() => {})
    }
  })
  await vi.advanceTimersByTimeAsync(3_000)
  const value = await pending
  expect(signal?.aborted).toBe(true)
  expect(value.hosts.map((host) => host.outcome)).toEqual(['searched', 'failed'])
  expect(value.partial).toBe(true)
})

it('cancels a stalled host call and releases its timeout', async () => {
  vi.useFakeTimers()
  const local = client('local')
  const controller = new AbortController()
  let signal: AbortSignal | undefined
  vi.mocked(local.call).mockImplementation(async (_method, _params, options) => {
    signal = options?.signal
    return new Promise(() => {})
  })
  const pending = searchAllHosts(local, query, controller.signal, Date.now() + 30_000, {
    listEnvironments: () => [],
    createClient: () => local,
    listSshTargets: async () => []
  })
  await vi.advanceTimersByTimeAsync(1)
  controller.abort()
  expect((await pending).hosts[0]?.outcome).toBe('unavailable')
  expect(signal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
