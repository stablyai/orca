import { describe, expect, it, vi } from 'vitest'

const listQuickOpenFilesMock = vi.hoisted(() => vi.fn())
vi.mock('../../../ipc/filesystem/filesystem-list-files', () => ({
  listQuickOpenFiles: listQuickOpenFilesMock
}))

import { RuntimeFileSearch, type RuntimeFileSearchHost } from './file-search'

function search(executionHostId: 'local' | `ssh:${string}`) {
  const host: RuntimeFileSearchHost = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mobile path search hands the store only to the mocked listQuickOpenFiles.
    requireStore: () => ({}) as ReturnType<RuntimeFileSearchHost['requireStore']>,
    resolveRuntimeFileTarget: async () => ({
      worktree: { id: 'wt-1', path: '/repo' },
      executionHostId
    })
  }
  return new RuntimeFileSearch(host)
}

describe('RuntimeFileSearch.searchMobileFilePaths', () => {
  it("ranks the cached workspace listing with desktop's fuzzy Quick Open rule", async () => {
    listQuickOpenFilesMock.mockResolvedValue([
      'docs/composer-notes.md',
      'src/NativeChatComposer.tsx',
      'src/native-chat/use-composer.ts'
    ])
    const files = search('local')

    const fuzzy = await files.searchMobileFilePaths('id:wt-1', 'ncomposer', 16)
    expect(fuzzy.files.map((file) => file.relativePath)).toContain('src/NativeChatComposer.tsx')

    const bare = await files.searchMobileFilePaths('id:wt-1', '', 2)
    expect(bare.files.map((file) => file.relativePath)).toEqual([
      'docs/composer-notes.md',
      'src/native-chat/use-composer.ts'
    ])
    expect(bare).toMatchObject({ totalCount: 3, truncated: true })
    expect(listQuickOpenFilesMock).toHaveBeenCalledOnce()
  })

  it('lists nothing for an SSH workspace', async () => {
    listQuickOpenFilesMock.mockClear()
    const result = await search('ssh:box').searchMobileFilePaths('id:wt-1', 'a', 16)
    expect(result).toMatchObject({ files: [], totalCount: 0, truncated: false })
    expect(listQuickOpenFilesMock).not.toHaveBeenCalled()
  })
})
