import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const OLD_FETCH = globalThis.fetch
const { closeAllConnectionsMock, netFetchMock, resolveProxyMock, setProxyMock } = vi.hoisted(
  () => ({
    closeAllConnectionsMock: vi.fn(),
    netFetchMock: vi.fn(),
    resolveProxyMock: vi.fn(),
    setProxyMock: vi.fn()
  })
)

let tempHome = ''

type WorkspaceFixture = { id: string; urlSlug: string; mentionName: string }

function writeWorkspaces(workspaces: WorkspaceFixture[], selectedWorkspaceId: string): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(join(orcaDir, 'shortcut-tokens'), { recursive: true })
  writeFileSync(
    join(orcaDir, 'shortcut-workspaces.json'),
    JSON.stringify({
      version: 1,
      activeWorkspaceId: workspaces[0]?.id ?? null,
      selectedWorkspaceId,
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        urlSlug: workspace.urlSlug,
        name: workspace.urlSlug,
        memberId: `member-${workspace.id}`,
        memberName: workspace.mentionName,
        mentionName: workspace.mentionName
      }))
    }),
    { encoding: 'utf-8' }
  )
  for (const workspace of workspaces) {
    writeFileSync(
      join(orcaDir, 'shortcut-tokens', `${Buffer.from(workspace.id).toString('base64url')}.enc`),
      `token-${workspace.id}`
    )
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const WORKFLOWS_FIXTURE = [
  {
    id: 7,
    name: 'Engineering',
    default_state_id: 100,
    states: [
      { id: 100, name: 'To Do', type: 'unstarted', position: 0 },
      { id: 101, name: 'In Progress', type: 'started', position: 1 },
      { id: 102, name: 'Done', type: 'done', position: 2 }
    ]
  }
]

const MEMBERS_FIXTURE = [
  {
    id: 'member-uuid-1',
    disabled: false,
    profile: {
      name: 'Ada Lovelace',
      mention_name: 'ada',
      email_address: 'ada@example.com',
      display_icon: { url: 'https://example.com/ada.png' }
    }
  }
]

const GROUPS_FIXTURE = [
  { id: 'group-uuid-1', name: 'Core', archived: false, workflow_ids: [7], default_workflow_id: 7 }
]

function storyFixture(
  id: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    name: `Story ${id}`,
    app_url: `https://app.shortcut.com/acme/story/${id}/story-${id}`,
    story_type: 'feature',
    workflow_state_id: 101,
    workflow_id: 7,
    group_id: 'group-uuid-1',
    owner_ids: ['member-uuid-1'],
    requested_by_id: 'member-uuid-1',
    labels: [{ name: 'backend' }],
    archived: false,
    completed: false,
    started: true,
    blocked: false,
    estimate: 3,
    updated_at: '2026-08-20T10:00:00Z',
    created_at: '2026-08-01T10:00:00Z',
    ...overrides
  }
}

function routeMetadataAndSearch(
  searchHandler: (url: string) => Response | Promise<Response>
): void {
  netFetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/v3/workflows')) {
      return jsonResponse(WORKFLOWS_FIXTURE)
    }
    if (url.includes('/api/v3/members')) {
      return jsonResponse(MEMBERS_FIXTURE)
    }
    if (url.includes('/api/v3/groups')) {
      return jsonResponse(GROUPS_FIXTURE)
    }
    if (url.includes('/api/v3/search/stories')) {
      return searchHandler(url)
    }
    throw new Error(`unexpected url: ${url}`)
  })
}

async function loadStoriesModule() {
  vi.resetModules()
  vi.doMock('electron', () => ({
    net: { fetch: netFetchMock },
    session: {
      defaultSession: {
        closeAllConnections: closeAllConnectionsMock,
        resolveProxy: resolveProxyMock,
        setProxy: setProxyMock
      }
    }
  }))
  const { setMainHttpClient } = await import('../network/http-client')
  setMainHttpClient({
    fetch: (url, init) => netFetchMock(url, init),
    proxySession: () => ({ resolveProxy: resolveProxyMock, setProxy: setProxyMock }) as never
  })
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString('utf-8'),
    describeProtectionGap: () => null
  })
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  const [stories, client] = await Promise.all([import('./stories'), import('./client')])
  return { ...stories, ...client }
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-shortcut-stories-'))
  netFetchMock.mockReset()
  resolveProxyMock.mockReset()
  setProxyMock.mockReset()
  closeAllConnectionsMock.mockReset()
  resolveProxyMock.mockResolvedValue('DIRECT')
  globalThis.fetch = vi.fn(async () => {
    throw new Error('fetch should not be called')
  }) as typeof fetch
  vi.restoreAllMocks()
})

afterEach(() => {
  globalThis.fetch = OLD_FETCH
})

describe('Shortcut story reads', () => {
  it('lists assigned stories via the search API scoped to the member mention name', async () => {
    writeWorkspaces([{ id: 'ws-1', urlSlug: 'acme', mentionName: 'ada' }], 'ws-1')
    routeMetadataAndSearch(() => jsonResponse({ total: 1, data: [storyFixture(42)], next: null }))
    const shortcut = await loadStoriesModule()

    const stories = await shortcut.listStories('assigned', 30, 'ws-1')

    expect(stories).toHaveLength(1)
    expect(stories[0]).toMatchObject({
      id: '42',
      title: 'Story 42',
      url: 'https://app.shortcut.com/acme/story/42/story-42',
      storyType: 'feature',
      state: { id: '101', name: 'In Progress', type: 'started' },
      team: expect.objectContaining({ id: 'group-uuid-1', name: 'Core' }),
      labels: ['backend'],
      owners: [expect.objectContaining({ id: 'member-uuid-1', name: 'Ada Lovelace' })],
      estimate: 3
    })

    const searchCall = netFetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/v3/search/stories')
    )
    const searchUrl = new URL(String(searchCall?.[0]))
    expect(searchUrl.searchParams.get('query')).toBe('owner:ada !is:done !is:archived')
    expect(searchUrl.searchParams.get('detail')).toBe('slim')
  })

  it('builds the per-filter queries from the connected member', async () => {
    writeWorkspaces([{ id: 'ws-1', urlSlug: 'acme', mentionName: 'ada' }], 'ws-1')
    const queries: string[] = []
    routeMetadataAndSearch((url) => {
      queries.push(new URL(url).searchParams.get('query') ?? '')
      return jsonResponse({ total: 0, data: [], next: null })
    })
    const shortcut = await loadStoriesModule()

    await shortcut.listStories('requested', 30, 'ws-1')
    await shortcut.listStories('done', 30, 'ws-1')
    await shortcut.listStories('all', 30, 'ws-1')

    expect(queries).toEqual([
      'requester:ada !is:done !is:archived',
      'owner:ada is:done',
      '!is:done !is:archived'
    ])
  })

  it('merges an all-workspaces fan-out by recency and tolerates one failing workspace', async () => {
    writeWorkspaces(
      [
        { id: 'ws-1', urlSlug: 'acme', mentionName: 'ada' },
        { id: 'ws-2', urlSlug: 'globex', mentionName: 'brie' }
      ],
      'all'
    )
    routeMetadataAndSearch((url) => {
      if (url.includes('owner%3Aada') || url.includes('owner:ada')) {
        return jsonResponse({
          total: 1,
          data: [storyFixture(1, { updated_at: '2026-08-10T10:00:00Z' })],
          next: null
        })
      }
      return jsonResponse({ message: 'boom' }, 500)
    })
    const shortcut = await loadStoriesModule()

    const stories = await shortcut.listStories('assigned', 30, 'all')

    expect(stories.map((story) => story.id)).toEqual(['1'])
  })

  it('surfaces the failure and clears the token on a 401 for a specific workspace', async () => {
    writeWorkspaces([{ id: 'ws-1', urlSlug: 'acme', mentionName: 'ada' }], 'ws-1')
    routeMetadataAndSearch(() => jsonResponse({ message: 'Unauthorized' }, 401))
    const shortcut = await loadStoriesModule()

    await expect(shortcut.searchStories('anything', 30, 'ws-1')).rejects.toThrow(/401/)
    expect(shortcut.getStatus().connected).toBe(false)
    expect(
      existsSync(
        join(
          tempHome,
          '.orca',
          'shortcut-tokens',
          `${Buffer.from('ws-1').toString('base64url')}.enc`
        )
      )
    ).toBe(false)
  })

  it('fetches a full story and maps comments through the workspace directory', async () => {
    writeWorkspaces([{ id: 'ws-1', urlSlug: 'acme', mentionName: 'ada' }], 'ws-1')
    netFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/v3/workflows')) {
        return jsonResponse(WORKFLOWS_FIXTURE)
      }
      if (url.includes('/api/v3/members')) {
        return jsonResponse(MEMBERS_FIXTURE)
      }
      if (url.includes('/api/v3/groups')) {
        return jsonResponse(GROUPS_FIXTURE)
      }
      if (url.endsWith('/api/v3/stories/42/comments')) {
        return jsonResponse([
          {
            id: 9,
            text: 'Looks good',
            author_id: 'member-uuid-1',
            created_at: '2026-08-21T10:00:00Z',
            deleted: false
          },
          { id: 10, text: null, author_id: 'member-uuid-1', created_at: '2026-08-22T10:00:00Z' }
        ])
      }
      if (url.endsWith('/api/v3/stories/42')) {
        return jsonResponse(storyFixture(42, { description: 'A **story**' }))
      }
      throw new Error(`unexpected url: ${url}`)
    })
    const shortcut = await loadStoriesModule()

    const story = await shortcut.getStory('42', 'ws-1')
    expect(story).toMatchObject({ id: '42', description: 'A **story**' })

    const comments = await shortcut.getStoryComments('42', 'ws-1')
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({
      id: '9',
      body: 'Looks good',
      author: expect.objectContaining({ name: 'Ada Lovelace' })
    })
  })

  it('returns null for a story no connected workspace can resolve', async () => {
    writeWorkspaces([{ id: 'ws-1', urlSlug: 'acme', mentionName: 'ada' }], 'ws-1')
    netFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/v3/workflows')) {
        return jsonResponse(WORKFLOWS_FIXTURE)
      }
      if (url.includes('/api/v3/members')) {
        return jsonResponse(MEMBERS_FIXTURE)
      }
      if (url.includes('/api/v3/groups')) {
        return jsonResponse(GROUPS_FIXTURE)
      }
      return jsonResponse({ message: 'Resource not found.' }, 404)
    })
    const shortcut = await loadStoriesModule()

    await expect(shortcut.getStory('999', 'ws-1')).resolves.toBeNull()
  })
})
