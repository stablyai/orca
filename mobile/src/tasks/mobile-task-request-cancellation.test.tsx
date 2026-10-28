import { createElement, useLayoutEffect, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, type SentRequest } from '../mobile-web-shell/bridge-host-test-fakes'
import type { ConnectionState, RpcResponse } from '../transport/types'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
import type {
  ProviderLoadActionsInput,
  ProviderLoadActionsModel
} from './use-mobile-tasks-provider-load-actions'
import type { TaskListLoadingModel } from './use-mobile-tasks-task-list-loading'

vi.mock('./mobile-tasks-dependencies', async () => ({
  ...(await import('react')),
  ...(await import('../theme/mobile-theme')),
  ...(await import('../../../src/shared/work-items')),
  ...(await import('./hosted-repo-selection')),
  ...(await import('./github-work-item-source-errors')),
  ...(await import('./mobile-workspace-name')),
  TaskProviderLogo: () => null
}))
vi.mock('./mobile-tasks-legacy-foundation', async () => ({
  ...(await import('./mobile-tasks-item-mapping')),
  ...(await import('./mobile-tasks-options')),
  ...(await import('./mobile-tasks-repository-presentation'))
}))

import { useMobileTasksProviderLoadActions } from './use-mobile-tasks-provider-load-actions'
import { useMobileTasksTaskListLoading } from './use-mobile-tasks-task-list-loading'
import { useMobileTasksTaskPaginationActions } from './use-mobile-tasks-task-pagination-actions'

type Provider = 'github' | 'gitlab'
const mounted = new Set<ReactTestRenderer>()
afterEach(() => {
  act(() => {
    for (const renderer of mounted) {
      renderer.unmount()
    }
  })
  mounted.clear()
})

function reply(request: SentRequest): RpcResponse {
  if (request.method === 'github.countWorkItems') {
    return { id: 'count', ok: true, result: { count: 100 } }
  }
  const params = request.args[1]
  const query =
    params && typeof params === 'object' && 'query' in params ? String(params.query) : ''
  return {
    id: 'list',
    ok: true,
    result: {
      items: [
        {
          id: 'issue-1',
          type: 'issue',
          number: 1,
          title: query,
          state: 'open',
          labels: [],
          url: 'https://example.com/issues/1',
          updatedAt: '2026-10-27T00:00:00Z',
          author: null
        }
      ]
    }
  }
}

async function mount(provider: Provider, repoCount = 30, counted = false) {
  const client = createFakeRpcClient()
  const scope: {
    query: string
    provider: Provider
    client: typeof client
    connState: ConnectionState
  } = {
    query: 'old-query',
    provider,
    client,
    connState: 'connected'
  }
  const repos = Array.from({ length: repoCount }, (_, index) => ({
    id: `repo-${index}`,
    displayName: `Repo ${index}`,
    path: `/repo-${index}`,
    kind: 'git' as const
  }))
  const shared = {
    clientRef: { current: client },
    loadGenerationRef: { current: 0 },
    defaultLinearTeamSelectionRef: { current: null },
    jiraStatusRequestIdRef: { current: 0 },
    setJiraConnection: vi.fn(),
    setLinearConnected: vi.fn(),
    setLinearTeams: vi.fn(),
    setLinearWorkspaces: vi.fn(),
    setSelectedLinearTeamIds: vi.fn(),
    setSelectedLinearWorkspaceId: vi.fn(),
    setError: vi.fn(),
    setGithubRepoSources: vi.fn(),
    setGithubSourceErrors: vi.fn(),
    setGithubSourceFallbacks: vi.fn(),
    setLoading: vi.fn(),
    setRefreshing: vi.fn(),
    setGithubLoadingTargetPage: vi.fn(),
    repoListEnsureLoaded: async () => repos,
    selectedLinearTeamIds: new Set<string>(),
    effectiveRepoIds: new Set(counted ? repos.map((repo) => repo.id) : []),
    serverRepoList: [],
    jiraConnection: { connected: false },
    resetGitHubItemsState: vi.fn()
  }
  let current: ReturnType<typeof useMobileTasksTaskPaginationActions> | undefined
  function Harness() {
    const [items, setItems] = useState<TaskItem[]>([])
    const [githubPages, setGithubPages] = useState<Extract<TaskItem, { provider: 'github' }>[][]>(
      []
    )
    const [githubCurrentPage, setGithubCurrentPage] = useState(0)
    const [githubCountedTotalPages, setGithubCountedTotalPages] = useState<number | null>(null)
    const [githubPaginationLoading, setGithubPaginationLoading] = useState(false)
    useLayoutEffect(() => {
      shared.clientRef.current = scope.client
    }, [scope.client])
    const input = {
      ...shared,
      client: scope.client,
      connState: scope.connState,
      provider: scope.provider,
      appliedQuery: scope.query,
      githubKind: 'issues',
      githubMode: 'items',
      gitlabFilter: 'opened',
      gitlabView: 'project',
      jiraFilter: 'assigned',
      linearConnected: false,
      linearFilter: 'all',
      linearOrderBy: 'priority',
      selectedLinearWorkspaceId: null,
      taskUiReady: true,
      tasksSupported: true,
      taskStateHydrated: true,
      items,
      setItems,
      githubPages,
      setGithubPages,
      githubCurrentPage,
      setGithubCurrentPage,
      githubCountedTotalPages,
      setGithubCountedTotalPages,
      githubPaginationLoading,
      setGithubPaginationLoading,
      selectedHostedRepos: repos
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every input read by the provider, list and pagination hooks on the task-list paths exercised here.
    const provided = useMobileTasksProviderLoadActions(input as unknown as ProviderLoadActionsInput)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture above includes the list hook's runtime fields; the full app model also carries unrelated dialogs and mutations.
    const loaded = useMobileTasksTaskListLoading(provided as ProviderLoadActionsModel)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture above includes all page-navigation fields and never invokes account connection or retry mutations.
    current = useMobileTasksTaskPaginationActions(loaded as TaskListLoadingModel)
    return null
  }
  let renderer: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(Harness))
    mounted.add(renderer)
  })
  const answered = new Set<SentRequest>()
  const pending = () => client.requests.filter((request) => !answered.has(request))
  return {
    client,
    scope,
    model: () => current!,
    async render() {
      await act(async () => renderer.update(createElement(Harness)))
    },
    async load(options?: { silent?: boolean }) {
      let request: Promise<void> | undefined
      await act(async () => {
        request = current!.loadTasks(options)
      })
      return { request: request! }
    },
    pending,
    async answer(requests = pending()) {
      await act(async () => {
        for (const request of requests) {
          answered.add(request)
          request.resolve(reply(request))
        }
      })
    },
    async drain() {
      for (let turn = 0; turn < repoCount + 2 && pending().length > 0; turn++) {
        await this.answer()
      }
      expect(pending()).toHaveLength(0)
    },
    unmount() {
      act(() => renderer.unmount())
      mounted.delete(renderer)
    }
  }
}

const starts = (requests: readonly SentRequest[], method: string) =>
  requests.filter((request) => request.method === method)

describe('task repository request ownership', () => {
  for (const provider of ['github', 'gitlab'] as const) {
    for (const repoCount of [30, 300]) {
      it(`stops queued ${provider} requests when a ${repoCount}-repo search is replaced`, async () => {
        const fixture = await mount(provider, repoCount)
        const old = await fixture.load()
        const oldRequests = fixture.pending()
        expect(oldRequests).toHaveLength(3)
        fixture.scope.query = 'new-query'
        await fixture.render()
        const live = await fixture.load()
        await fixture.answer(oldRequests)
        expect(starts(fixture.client.requests, `${provider}.listWorkItems`)).toHaveLength(6)
        await fixture.drain()
        await Promise.all([old.request, live.request])
        expect(starts(fixture.client.requests, `${provider}.listWorkItems`)).toHaveLength(
          repoCount + 3
        )
        expect(fixture.model().items).toHaveLength(repoCount)
        expect(fixture.model().items.every((item) => item.title.includes('new-query'))).toBe(true)
      })
    }
  }

  it('stops obsolete page counts when the provider changes, keeping live GitLab rows', async () => {
    const fixture = await mount('github', 30, true)
    const first = await fixture.load()
    while (fixture.pending().some((request) => request.method === 'github.listWorkItems')) {
      await fixture.answer(
        fixture.pending().filter((request) => request.method === 'github.listWorkItems')
      )
    }
    await first.request
    const counts = fixture.pending()
    expect(starts(counts, 'github.countWorkItems')).toHaveLength(3)
    fixture.scope.provider = 'gitlab'
    await fixture.render()
    const live = await fixture.load()
    await fixture.answer(counts)
    await fixture.drain()
    await live.request
    expect(starts(fixture.client.requests, 'github.countWorkItems')).toHaveLength(3)
    expect(fixture.model().items).toHaveLength(30)
    expect(fixture.model().items.every((item) => item.provider === 'gitlab')).toBe(true)
  })

  it('stops queued next-page requests when the list reloads', async () => {
    const fixture = await mount('github')
    const first = await fixture.load()
    await fixture.drain()
    await first.request
    let page: Promise<void> | undefined
    await act(async () => {
      page = fixture.model().handleGitHubPageChange(1)
    })
    const pageRequests = fixture.pending()
    expect(pageRequests).toHaveLength(3)
    fixture.scope.query = 'new-query'
    await fixture.render()
    const live = await fixture.load()
    await fixture.answer(pageRequests)
    await fixture.drain()
    await Promise.all([page, live.request])
    const nextPage = fixture.client.requests.filter((request) => {
      const params = request.args[1]
      return params && typeof params === 'object' && 'page' in params && params.page === 2
    })
    expect(nextPage).toHaveLength(3)
    expect(fixture.model().githubPages).toHaveLength(1)
    expect(fixture.model().items.every((item) => item.title.includes('new-query'))).toBe(true)
  })

  for (const reason of ['unmount', 'disconnect', 'client-change'] as const) {
    it(`stops the queued list after ${reason}`, async () => {
      const fixture = await mount('github')
      const old = await fixture.load()
      if (reason === 'unmount') {
        fixture.unmount()
      } else {
        if (reason === 'disconnect') {
          fixture.scope.connState = 'disconnected'
        } else {
          fixture.scope.client = createFakeRpcClient()
        }
        await fixture.render()
      }
      await fixture.drain()
      await old.request
      expect(starts(fixture.client.requests, 'github.listWorkItems')).toHaveLength(3)
      expect(fixture.model().items).toEqual([])
      expect(fixture.model().setLoading).toHaveBeenLastCalledWith(false)
    })
  }

  it('releases the refresh spinner when a silent reload is abandoned by disconnect', async () => {
    const fixture = await mount('github')
    const old = await fixture.load({ silent: true })
    fixture.scope.connState = 'disconnected'
    await fixture.render()
    await fixture.drain()
    await old.request
    expect(fixture.model().setRefreshing).toHaveBeenLastCalledWith(false)
  })
})
