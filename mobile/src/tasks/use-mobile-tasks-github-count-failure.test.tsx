import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The module under test reaches the Tasks barrel, which pulls React Native in. Both barrels are
// stubbed with self-contained equivalents; `mapWithConcurrency` reproduces the shipped one
// (`mobile-tasks-item-mapping.ts`), which awaits each worker and so rejects the whole batch if
// any worker rejects. That is precisely the propagation this test pins the guard against.
vi.mock('./mobile-tasks-dependencies', () => ({
  CROSS_REPO_DISPLAY_LIMIT: 200,
  PER_REPO_FETCH_LIMIT: 100,
  extractGitHubIssueSourceError: () => null,
  extractGitHubIssueSourceFallback: () => null,
  isGitHubWorkItemsSshRemoteRequiredError: () => false,
  useCallback: <T,>(callback: T): T => callback
}))
vi.mock('./mobile-tasks-legacy-foundation', () => ({
  GITHUB_REPO_CONCURRENCY: 3,
  createGitHubTask: (item: unknown) => item,
  async mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<R>
  ): Promise<R[]> {
    const results: R[] = []
    let nextIndex = 0
    async function run(): Promise<void> {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await worker(items[index]!)
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
    return results
  },
  reconcileTeamSelection: () => new Set<string>(),
  scopeGitHubTaskSearch: (query: string): string => query,
  taskTime: () => 0
}))

const { useMobileTasksProviderLoadActions } =
  await import('./use-mobile-tasks-provider-load-actions')

type CountOperations = { countGitHub: (payload: { repoId: string }) => Promise<number> }
type LoadActions = { countGitHubItems: (operations: unknown, repos: unknown[]) => Promise<number> }

const repo = (id: string): { id: string } => ({ id })

describe('github work-item counting', () => {
  let renderer: ReactTestRenderer | null = null

  function mount(): LoadActions {
    let model: LoadActions | null = null
    function Probe(): null {
      model = useMobileTasksProviderLoadActions({
        appliedQuery: 'is:open',
        githubKind: 'issues'
      } as never) as unknown as LoadActions
      return null
    }
    act(() => {
      renderer = create(createElement(Probe))
    })
    if (!model) {
      throw new Error('hook did not render')
    }
    return model
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it('reads a failed per-repo count as zero and still resolves the total', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const countGitHub = vi.fn(async ({ repoId }: { repoId: string }) => {
      if (repoId === 'repo-broken') {
        throw new Error('count failed')
      }
      return repoId === 'repo-a' ? 3 : 4
    })
    const operations: CountOperations = { countGitHub }
    const model = mount()

    // Returning the promise instead of awaiting it would let this rejection escape the per-repo
    // catch and reject the whole batch, and the only caller fires this with no handler.
    await expect(
      model.countGitHubItems(operations, [repo('repo-a'), repo('repo-broken'), repo('repo-b')])
    ).resolves.toBe(7)
    expect(countGitHub).toHaveBeenCalledTimes(3)
  })
})
