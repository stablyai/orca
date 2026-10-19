import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./mobile-tasks-dependencies', async () => {
  const react = await import('react')
  return {
    useCallback: react.useCallback,
    useMemo: react.useMemo,
    ...(await import('../../../src/shared/work-items'))
  }
})
vi.mock('./mobile-tasks-legacy-foundation', () => ({
  buildPartialRepositoryNotice: () => 'partial'
}))
vi.mock('./mobile-task-list-operations', () => ({ linearAccountConnect: {} }))

import { useMobileTasksTaskPaginationActions } from './use-mobile-tasks-task-pagination-actions'
import type { TaskListLoadingModel } from './use-mobile-tasks-task-list-loading'

const client = { id: 'client' }
type PageRow = { key: string; updatedAt?: string; source?: { repoId: string } }

const firstPage: PageRow[] = [{ key: 'github:repo-1:issue:40', updatedAt: '2026-10-02T00:00:00Z' }]
const oldSelectionPage = [{ key: 'github:repo-1:issue:4', updatedAt: '2026-10-01T00:00:00Z' }]

function buildModel(
  fetchGitHubItemsPage: () => Promise<unknown>,
  githubCountedTotalPages: number | null = 2
) {
  return {
    client,
    clientRef: { current: client },
    connState: 'connected',
    fetchGitHubItemsPage: vi.fn(fetchGitHubItemsPage),
    githubCurrentPage: 0,
    githubPages: [firstPage],
    githubPaginationLoading: false,
    githubCountedTotalPages,
    loadGenerationRef: { current: 1 },
    selectedHostedRepos: [{ id: 'repo-1' }],
    tasksSupported: true,
    taskUiReady: true,
    setError: vi.fn(),
    setGithubCurrentPage: vi.fn(),
    setGithubLoadingTargetPage: vi.fn(),
    setGithubPages: vi.fn(),
    setGithubPaginationLoading: vi.fn(),
    setItems: vi.fn()
  }
}

let renderer: ReactTestRenderer | null = null
let changePage: ((page: number) => Promise<void>) | null = null
let canLoadUncountedNextPage = false

function mount(model: ReturnType<typeof buildModel>): void {
  function Harness(): null {
    const actions = useMobileTasksTaskPaginationActions(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture carries every member the page handler reads.
      model as unknown as TaskListLoadingModel
    )
    changePage = actions.handleGitHubPageChange
    canLoadUncountedNextPage = actions.githubCanLoadUncountedNextPage
    return null
  }
  act(() => {
    renderer = create(createElement(Harness))
  })
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  changePage = null
})

describe('GitHub task page change', () => {
  it('asks for the target page by number and shows it', async () => {
    const model = buildModel(async () => ({
      items: oldSelectionPage,
      failedCount: 0
    }))
    mount(model)
    await act(async () => {
      await changePage?.(1)
    })
    expect(model.fetchGitHubItemsPage).toHaveBeenCalledWith(client, model.selectedHostedRepos, 1)
    expect(model.setGithubPages).toHaveBeenCalledWith([firstPage, oldSelectionPage])
    expect(model.setItems).toHaveBeenCalledWith(oldSelectionPage)
  })

  it('drops a page that lands after the list reloaded for a new selection', async () => {
    let land: (page: unknown) => void = () => {}
    const model = buildModel(
      () =>
        new Promise((resolve) => {
          land = resolve
        })
    )
    mount(model)
    let pending: Promise<void> | undefined
    act(() => {
      pending = changePage?.(1)
    })
    // The repo picker changed: loadTasks bumps the generation and loads the new list.
    model.loadGenerationRef.current += 1
    await act(async () => {
      land({ items: oldSelectionPage, failedCount: 0 })
      await pending
    })
    expect(model.setGithubPages).not.toHaveBeenCalled()
    expect(model.setItems).not.toHaveBeenCalled()
    expect(model.setGithubPaginationLoading).toHaveBeenLastCalledWith(false)
  })

  describe('without a count, as in the default all-repos view', () => {
    function rows(repoId: string, count: number): PageRow[] {
      return Array.from({ length: count }, (_, index) => ({
        key: `github:${repoId}:issue:${index}`,
        source: { repoId }
      }))
    }

    function lastPageOffersNext(page: PageRow[]): boolean {
      const model = buildModel(async () => ({ items: [], failedCount: 0 }), null)
      model.githubPages = [page]
      model.selectedHostedRepos = [{ id: 'repo-a' }, { id: 'repo-b' }]
      mount(model)
      return canLoadUncountedNextPage
    }

    it('offers the next page when one repo filled its share and another did not', () => {
      expect(lastPageOffersNext([...rows('repo-a', 36), ...rows('repo-b', 5)])).toBe(true)
    })

    it('offers no next page when no repo filled its share', () => {
      expect(lastPageOffersNext([...rows('repo-a', 20), ...rows('repo-b', 5)])).toBe(false)
    })
  })
})
