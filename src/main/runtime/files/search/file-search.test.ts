import { describe, expect, it, vi } from 'vitest'
import { ExecutionHostNotDispatchableError } from '../../../providers/execution-host-provider-dispatch'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../../../providers/ssh-host-not-served-error'
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
  it('rejects an already-aborted request before resolving its workspace', async () => {
    const { search, requireStore, resolveRuntimeFileTarget } = createSearch()
    const controller = new AbortController()
    controller.abort()
    await expect(
      search.searchRuntimeFiles('folder-1', { query: 'needle' }, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(resolveRuntimeFileTarget).not.toHaveBeenCalled()
    expect(requireStore).not.toHaveBeenCalled()
  })

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

  it('never searches this machine for a workspace owned by another runtime', async () => {
    const { search, requireStore } = createSearch('runtime:other')
    await expect(search.searchRuntimeFiles('folder-1', { query: 'needle' })).rejects.toBeInstanceOf(
      ExecutionHostNotDispatchableError
    )
    await expect(search.listRuntimeFiles('folder-1')).rejects.toBeInstanceOf(
      ExecutionHostNotDispatchableError
    )
    expect(requireStore).not.toHaveBeenCalled()
  })

  it('preserves distinct search and listing results for unavailable SSH hosts', async () => {
    const { search, requireStore } = createSearch('ssh:unavailable')
    await expect(search.searchRuntimeFiles('folder-1', { query: 'needle' })).rejects.toThrow(
      SSH_HOST_NOT_SERVED_MESSAGE
    )
    await expect(search.listRuntimeFiles('folder-1')).resolves.toEqual([])
    await expect(search.searchQuickOpenFilePaths('folder-1', 'needle', 10)).resolves.toEqual({
      worktree: 'folder-1',
      rootPath: '/same-root',
      files: [],
      totalCount: 0,
      truncated: false,
      quickOpenSearchVersion: 0
    })
    expect(requireStore).not.toHaveBeenCalled()
  })
})
