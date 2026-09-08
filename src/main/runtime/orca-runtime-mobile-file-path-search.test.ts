import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QUICK_OPEN_READDIR_MAX_FILES } from '../../shared/quick-open-readdir-budget'

const { listQuickOpenFilesMock } = vi.hoisted(() => ({
  listQuickOpenFilesMock: vi.fn()
}))

vi.mock('../ipc/filesystem-list-files', () => ({
  listQuickOpenFiles: listQuickOpenFilesMock
}))

import { RuntimeFileCommands } from './orca-runtime-files'

describe('runtime mobile file path search', () => {
  beforeEach(() => {
    listQuickOpenFilesMock.mockReset()
  })

  it('keeps the sentinel scan within the no-ripgrep fallback budget', async () => {
    const store = {}
    const paths = Array.from(
      { length: QUICK_OPEN_READDIR_MAX_FILES },
      (_, index) => `z-generated/file-${String(index).padStart(5, '0')}.ts`
    )
    paths[QUICK_OPEN_READDIR_MAX_FILES - 2] = 'mobile/pnpm-lock.yaml'
    listQuickOpenFilesMock.mockResolvedValue(paths)
    const commands = new RuntimeFileCommands({
      getRuntimeId: () => 'runtime-1',
      requireStore: () => store,
      resolveRuntimeFileTarget: async () => ({
        worktree: {
          id: 'worktree-1',
          repoId: 'repo-1',
          path: '/repo'
        },
        executionHostId: 'local'
      })
    } as never)

    const result = await commands.searchMobileFilePaths(
      'id:worktree-1',
      'mobile/pnpm-lock.yaml',
      32
    )

    expect(listQuickOpenFilesMock).toHaveBeenCalledWith(
      '/repo',
      store,
      undefined,
      undefined,
      QUICK_OPEN_READDIR_MAX_FILES
    )
    expect(result).toEqual({
      worktree: 'worktree-1',
      rootPath: '/repo',
      files: [
        {
          relativePath: 'mobile/pnpm-lock.yaml',
          basename: 'pnpm-lock.yaml',
          kind: 'text'
        }
      ],
      totalCount: 1,
      truncated: true
    })
  })
})
