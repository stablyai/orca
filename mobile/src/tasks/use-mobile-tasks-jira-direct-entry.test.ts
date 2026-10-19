import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue } from '../../../src/shared/jira-types'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RepoSummary } from './mobile-tasks-provider-detail-types'
import { useHostRepoList, type HostRepoListResource } from './use-host-repo-list'
import { useMobileTasksTaskListLoading } from './use-mobile-tasks-task-list-loading'

vi.mock('./mobile-tasks-dependencies', async () => {
  const { useCallback, useEffect, useRef } = await import('react')
  return { useCallback, useEffect, useRef }
})
vi.mock('./mobile-tasks-legacy-foundation', async () => import('./mobile-tasks-item-mapping'))

const issue: JiraIssue = {
  id: '1',
  key: 'ORCA-7',
  title: 'Start from mobile Jira',
  url: 'https://acme.atlassian.net/browse/ORCA-7',
  siteId: 'site-a',
  description: '',
  labels: [],
  project: { id: 'p', key: 'ORCA', name: 'Orca' },
  issueType: { id: 'task', name: 'Task' },
  status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
  updatedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z'
}
const repo: RepoSummary = { id: 'repo-a', displayName: 'App', path: '/app', kind: 'folder' }
const mounted: ReactTestRenderer[] = []

afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) {
      renderer.unmount()
    }
  })
})

function mountJira(fetchRepos: () => Promise<RepoSummary[]>) {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue({ id: 'jira-test', ok: true, result: [issue] })
  const setItems = vi.fn()
  const setError = vi.fn()
  const serverRepoList: RepoSummary[] = []
  const effectiveRepoIds = new Set<string>()
  const holder: {
    repos?: HostRepoListResource<RepoSummary>
    load?: () => Promise<void>
  } = {}

  function Probe() {
    const repos = useHostRepoList(client, fetchRepos)
    holder.repos = repos
    holder.load = useMobileTasksTaskListLoading(
      mountFixture<Parameters<typeof useMobileTasksTaskListLoading>[0]>({
        appliedQuery: '',
        client,
        clientRef: { current: client },
        connState: 'connected',
        githubMode: 'items',
        gitlabFilter: 'opened',
        gitlabView: 'project',
        jiraConnection: { connected: true, selection: 'site-a' },
        jiraFilter: 'assigned',
        effectiveRepoIds,
        serverRepoList,
        linearConnected: false,
        loadGenerationRef: { current: 0 },
        provider: 'jira',
        repoListEnsureLoaded: repos.ensureLoaded,
        resetGitHubItemsState: vi.fn(),
        setError,
        setItems,
        setLoading: vi.fn(),
        setRefreshing: vi.fn(),
        taskStateHydrated: true,
        tasksSupported: true
      })
    ).loadTasks
    return null
  }

  act(() => {
    mounted.push(create(createElement(Probe)))
  })
  return {
    setItems,
    setError,
    get repos() {
      if (!holder.repos) {
        throw new Error('Repository resource did not render')
      }
      return holder.repos.state
    },
    async load() {
      await act(async () => {
        if (!holder.load) {
          throw new Error('Jira load did not render')
        }
        await holder.load()
      })
    }
  }
}

describe('direct mobile Jira entry', () => {
  it('loads workspace repositories without delaying the Jira issue list', async () => {
    let answer: (repos: RepoSummary[]) => void = () => {
      throw new Error('Repository request is not ready')
    }
    const response = new Promise<RepoSummary[]>((resolve) => {
      answer = resolve
    })
    const fetchRepos = vi.fn(() => response)
    const fixture = mountJira(fetchRepos)
    expect(fixture.repos.status).toBe('idle')

    await fixture.load()
    expect(fixture.setItems).toHaveBeenLastCalledWith([
      expect.objectContaining({ provider: 'jira', source: issue })
    ])
    expect(fetchRepos).toHaveBeenCalledTimes(1)
    expect(fixture.repos.status).toBe('loading')

    await act(async () => answer([repo]))
    expect(fixture.repos).toMatchObject({ status: 'loaded', repos: [repo] })
  })

  it('keeps Jira readable when the background repository request fails', async () => {
    const fetchRepos = vi.fn(async (): Promise<RepoSummary[]> => {
      throw new Error('Repository host unavailable')
    })
    const fixture = mountJira(fetchRepos)

    await fixture.load()
    expect(fetchRepos).toHaveBeenCalledTimes(1)
    expect(fixture.repos.status).toBe('error')
    expect(fixture.setItems).toHaveBeenLastCalledWith([
      expect.objectContaining({ provider: 'jira', source: issue })
    ])
    expect(fixture.setError).toHaveBeenLastCalledWith('')
  })
})
