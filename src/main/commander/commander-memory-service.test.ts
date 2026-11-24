import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  commanderMemoryService,
  askHomeMemoryPreference,
  saveCommanderMemory,
  publishRecoveryMemory
} from './commander-memory-service'

const scope = vi.hoisted(() => ({
  generation: 0,
  linkVersion: 0,
  userId: 'alice',
  activeOrgId: 'team'
}))
vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/profile'
}))
vi.mock('../orca-profiles/profile-index-store', () => ({
  readInitializedActiveOrcaProfile: async () => ({
    profile: { id: 'a', cloud: { userId: scope.userId, activeOrgId: scope.activeOrgId } }
  })
}))
vi.mock('../orca-profiles/cloud-session/profile-cloud-session-owner', () => ({
  takeCloudSessionTicket: () => ({ generation: scope.generation, linkVersion: scope.linkVersion })
}))
vi.mock('../orca-profiles/cloud-auth/profile-cloud-auth-config', () => ({
  getOrcaCloudAuthConfig: () => ({
    configured: true,
    config: { apiBaseUrl: 'https://login.example.test/foo' }
  })
}))
vi.mock('../orca-profiles/cloud-session/profile-cloud-session-refresh', () => ({
  runWithFreshOrcaCloudSession: async (
    _config: unknown,
    _active: unknown,
    _dir: unknown,
    op: (session: { accessToken: string }) => Promise<unknown>
  ) => ({ status: 'ok', value: await op({ accessToken: 'human-token' }) })
}))

const account = { profileId: 'a', userId: 'alice', activeOrgId: 'team' }
afterEach(() => {
  vi.unstubAllGlobals()
  Object.assign(scope, { generation: 0, linkVersion: 0, userId: 'alice', activeOrgId: 'team' })
})

describe('Commander account boundary', () => {
  it('pages a legacy service without returning unrelated bodies or losing linked pages outside the current list', async () => {
    const base = {
      kind: 'note',
      title: 'Note',
      actor: { type: 'human', id: 'alice' },
      createdBy: { type: 'human', id: 'alice' },
      version: 1,
      deleted: false,
      createdAt: '2026-11-01T00:00:00.000Z',
      projectId: 'app',
      links: [],
      body: 'résumé'
    }
    const pages = Array.from({ length: 51 }, (_, i) => ({
      ...base,
      pageId: `note-${String(i).padStart(2, '0')}`
    }))
    const fetch = vi.fn(async (url: URL) =>
      url.pathname.endsWith('/index')
        ? new Response(null, { status: 404 })
        : Response.json({
            pages: [...pages, { ...base, pageId: 'deleted', projectId: 'archived', deleted: true }]
          })
    )
    vi.stubGlobal('fetch', fetch)
    const first = await commanderMemoryService.index(account, {
      order: 'recent',
      q: 'RÉSUMÉ',
      includeDeletedProjects: true
    })
    expect(first.pages).toHaveLength(50)
    expect(first.pages[0]).not.toHaveProperty('body')
    expect(first.projects).toEqual(['app', 'archived'])
    expect(first.next).toBe('2026-11-01T00:00:00.000Z|note-49')
    const second = await commanderMemoryService.index(account, {
      order: 'recent',
      after: first.next!
    })
    expect(second.pages.map((p) => p.pageId)).toEqual(['note-50'])
    expect(second.next).toBeNull()
    const linked = await commanderMemoryService.index(account, {
      ids: ['deleted', 'note-50'],
      includeDeleted: true
    })
    expect(linked.pages.map((p) => p.pageId)).toEqual(['deleted', 'note-50'])
  })
  it('keeps an unauthorized index read from falling back to the full account list', async () => {
    const paths: string[] = []
    vi.stubGlobal('fetch', async (url: URL) => {
      paths.push(url.pathname)
      return new Response(null, { status: 403 })
    })
    await expect(commanderMemoryService.index(account, {})).rejects.toThrow('403')
    expect(paths).toEqual(['/v1/commander/memory/index'])
  })
  it('preserves strict handoffs and scoped guidance when a .7 or .8 server lacks the newer routes', async () => {
    const base = {
      title: 'A',
      body: 'go',
      kind: 'guideline',
      actor: { type: 'human', id: 'alice' },
      createdBy: { type: 'agent', id: 'agent-A' },
      version: 2,
      deleted: false,
      projectId: 'a/b',
      createdAt: '2026-11-01T00:00:00.000Z',
      links: []
    }
    const id = 'handoff-aaaaaaaa-bbbb-cccc-dddd-00000000000'
    const pages = [
      { ...base, pageId: 'a', body: '🙂'.repeat(4000) },
      { ...base, pageId: 'b' },
      { ...base, pageId: 'c', projectId: null, title: 'Global' },
      { ...base, pageId: 'd', title: 'Recurring answer' },
      { ...base, pageId: 'e', projectId: 'a/c' },
      { ...base, pageId: 'f', deleted: true },
      { ...base, pageId: 'g', actor: { type: 'commander', id: 'runner' } },
      { ...base, pageId: `${id}1`, kind: 'note' },
      {
        ...base,
        pageId: `${id}2`,
        kind: 'note',
        body: '## Progress\n\ndone\n\n## Next step\n\nship'
      }
    ]
    const paths: string[] = []
    vi.stubGlobal('fetch', async (url: URL) => {
      paths.push(url.pathname + url.search)
      return url.pathname.endsWith('/memory')
        ? Response.json({ pages })
        : new Response(null, { status: 404 })
    })
    const handoffs = await commanderMemoryService.index(account, {
      validHandoffsOnly: true,
      order: 'recent'
    })
    expect(handoffs.pages.map((page) => page.pageId)).toEqual([`${id}2`])
    expect(await commanderMemoryService.workerGuidance(account, 'a/b')).toEqual({
      guidelines: ['A (v2)\ngo', 'Global (v2)\ngo'],
      truncated: true
    })
    expect(paths).toEqual([
      '/v1/commander/memory/handoffs-index?order=recent',
      '/v1/commander/memory',
      '/v1/commander/memory/worker-guidance?projectId=a%2Fb',
      '/v1/commander/memory'
    ])
  })
  it('fails closed on unauthorized and oversized guidance reads', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ guidelines: ['🙂'.repeat(4000)], truncated: false }))
    vi.stubGlobal('fetch', fetch)
    await expect(commanderMemoryService.workerGuidance(account, 'app')).rejects.toThrow('403')
    await expect(commanderMemoryService.workerGuidance(account, 'app')).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('discards a reply after sign-out and reauthentication, even with the same user and org', async () => {
    const started = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', () => {
      started.resolve()
      return response.promise
    })
    const read = commanderMemoryService.list(account)
    await started.promise
    scope.generation++
    response.resolve(Response.json({ pages: [] }))
    await expect(read).rejects.toThrow('account changed')
  })
  it('rejects a draft from a different active org before sending it', async () => {
    scope.activeOrgId = 'other'
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(
      commanderMemoryService.save(account, {
        pageId: 'p',
        requestId: 'req',
        expectedVersion: 1,
        deleted: true
      })
    ).rejects.toThrow('account changed')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not send a phone edit if desktop sharing is revoked during cloud session refresh', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(
      saveCommanderMemory(
        account,
        { pageId: 'p', requestId: 'req', expectedVersion: 1, deleted: true },
        async () => {
          throw new Error('Sharing disabled')
        }
      )
    ).rejects.toThrow('Sharing disabled')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('uses a project-scoped commander for checkpoints and omits credentials from the response', async () => {
    const write = {
      pageId: `checkpoint-${'a'.repeat(64)}`,
      requestId: 'req',
      expectedVersion: 0,
      kind: 'note' as const,
      projectId: 'github:a/b',
      title: 'done',
      body: 'tests passed',
      links: []
    }
    const page = {
      ...write,
      createdAt: '2026-01-01',
      version: 1,
      actor: { type: 'commander', id: 'orca-checkpoint' },
      createdBy: { type: 'commander', id: 'orca-checkpoint' },
      deleted: false
    }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ token: 'orcacmd_scoped' }))
      .mockResolvedValueOnce(Response.json({ page, token: 'private', accessToken: 'secret' }))
    vi.stubGlobal('fetch', fetch)
    const result = await commanderMemoryService.checkpoint(account, write)
    expect(
      fetch.mock.calls.map(([url, options]) => [
        url.href,
        options.headers.Authorization,
        options.redirect
      ])
    ).toEqual([
      ['https://login.example.test/v1/commander/memory/delegations', 'Bearer human-token', 'error'],
      ['https://login.example.test/v1/commander/memory/commander', 'Bearer orcacmd_scoped', 'error']
    ])
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      type: 'commander',
      id: 'orca-checkpoint',
      projectId: 'github:a/b'
    })
    expect(result.page.actor.type).toEqual('commander')
    expect(Object.keys(result)).toEqual(['page'])
  })
})

describe('automated recovery publication', () => {
  const entry = {
    pageId: 'handoff-cb86a439-98d5-4a8b-b54a-c88adbf2ac28',
    projectId: 'github:a/b',
    title: 'Continue',
    body: 'updated progress'
  }
  const actor = { type: 'commander', id: 'orca-recovery' }
  const head = {
    ...entry,
    version: 2,
    kind: 'note',
    deleted: false,
    createdBy: actor,
    actor,
    createdAt: '2026-01-01',
    links: [],
    title: 'Ship a release',
    body: 'initial progress'
  }
  it('retains the goal when a later turn has a shorter prompt and fences the write by revision', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ page: head }))
      .mockResolvedValueOnce(Response.json({ token: 'orcacmd_recovery' }))
      .mockResolvedValueOnce(Response.json({ page: { ...head, version: 3, body: entry.body } }))
    vi.stubGlobal('fetch', fetch)
    await expect(publishRecoveryMemory(account, entry, async () => {})).resolves.toBe('synced')
    const [, opts] = fetch.mock.calls[2]!
    expect(JSON.parse(opts.body)).toMatchObject({
      expectedVersion: 2,
      title: 'Ship a release',
      body: 'updated progress'
    })
    expect(opts.headers.Authorization).toBe('Bearer orcacmd_recovery')
  })
  it('protects human revisions and checks for disabled recording before uploading', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ page: { ...head, actor: { type: 'human', id: 'alice' } } })
      )
    vi.stubGlobal('fetch', fetch)
    await expect(publishRecoveryMemory(account, entry, async () => {})).resolves.toBe('protected')
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(
      publishRecoveryMemory(account, entry, async () => {
        throw new Error('disabled')
      })
    ).rejects.toThrow('disabled')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

it('asks with the registered bot and project, keeps the grant on the host, and observes disable and re-enable on the same request', async () => {
  const decision = {
    matched: true,
    answer: 'pnpm test',
    rulePageId: 'rule',
    ruleVersion: 1,
    decisionPageId: 'decision'
  }
  const result = [
    { matched: false, reason: 'disabled' },
    decision,
    { matched: false, reason: 'disabled' },
    decision
  ]
  const calls: { path: string; body: unknown; auth: string | null }[] = []
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    calls.push({
      path: url.pathname,
      body: JSON.parse(String(init.body)),
      auth: new Headers(init.headers).get('Authorization')
    })
    return url.pathname.endsWith('/delegations')
      ? Response.json({ token: 'orcacmd_transient' })
      : Response.json({ ...result.shift(), token: 'never leave the host' })
  })
  const check = vi.fn()
  const ask = () =>
    askHomeMemoryPreference(
      account,
      'registered-bot',
      'github:a/b',
      'Test suite?',
      'question-1',
      check
    )
  await expect(ask()).resolves.toEqual({ matched: false, reason: 'disabled' })
  await expect(ask()).resolves.toEqual(decision)
  await expect(ask()).resolves.toEqual({ matched: false, reason: 'disabled' })
  await expect(ask()).resolves.toEqual(decision)
  expect(calls.slice(0, 2)).toEqual([
    {
      path: '/v1/commander/memory/delegations',
      auth: 'Bearer human-token',
      body: { type: 'commander', id: 'registered-bot', projectId: 'github:a/b' }
    },
    {
      path: '/v1/commander/memory/preferences/ask',
      auth: 'Bearer orcacmd_transient',
      body: {
        expectedProjectId: 'github:a/b',
        expectedActorType: 'commander',
        question: 'Test suite?',
        requestId: 'question-1'
      }
    }
  ])
  expect(check).toHaveBeenCalledTimes(8)
})

it('rejects a Home replacement during delegation before sending any preference question', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ token: 'orcacmd_transient' }))
  vi.stubGlobal('fetch', fetch)
  const check = vi
    .fn()
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error('revoked')
    })
  await expect(
    askHomeMemoryPreference(account, 'bot', 'repo', 'What?', 'q', check)
  ).rejects.toThrow('revoked')
  expect(fetch).toHaveBeenCalledTimes(1)
})
