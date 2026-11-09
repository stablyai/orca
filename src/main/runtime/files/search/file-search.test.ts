import { describe, expect, it, vi } from 'vitest'

import { RuntimeFileSearch, type RuntimeFileSearchHost } from './file-search'

function createSearch(executionHostId: 'local' | 'ssh:unavailable' | 'runtime:other' = 'local') {
  const requireStore = vi.fn(() => {
    throw new Error('Must not access local storage')
  })
  const resolveRuntimeFileTarget = vi.fn(async () => ({
    worktree: { id: 'folder-1', path: '/same-root' },
    executionHostId
  }))
  const search = new RuntimeFileSearch({ requireStore, resolveRuntimeFileTarget })
  return { search, requireStore, resolveRuntimeFileTarget }
}

describe('RuntimeFileSearch', () => {
  it('settles an abort while workspace resolution remains pending', async () => {
    const { requireStore } = createSearch()
    const resolveRuntimeFileTarget = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<RuntimeFileSearchHost['resolveRuntimeFileTarget']>>>(
          () => {}
        )
    )
    const search = new RuntimeFileSearch({ requireStore, resolveRuntimeFileTarget })
    const controller = new AbortController()
    const pending = search.searchRuntimeFiles(
      'folder-1',
      { query: 'needle' },
      { signal: controller.signal }
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(resolveRuntimeFileTarget).toHaveBeenCalledOnce()
    expect(requireStore).not.toHaveBeenCalled()
  })
})
