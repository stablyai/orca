import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MarkdownDocumentsModule from './markdown-documents'
import {
  handlers,
  store,
  WORKTREE_FEATURE_PATH,
  readdirMock,
  getSshFilesystemProviderMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

const { listMarkdownDocumentsMock, localOptionsMock } = vi.hoisted(() => ({
  listMarkdownDocumentsMock: vi.fn(),
  localOptionsMock: vi.fn()
}))

vi.mock('./markdown-documents', async (importOriginal) => ({
  ...(await importOriginal<typeof MarkdownDocumentsModule>()),
  listMarkdownDocuments: listMarkdownDocumentsMock
}))
vi.mock('./local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: localOptionsMock
}))

vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock(
  '../local-downloaded-folder-promotion',
  async () => (await import('./filesystem-test-harness')).folderPromotionMock
)
vi.mock(
  '../git/status',
  async () => (await import('./filesystem-test-harness')).gitStatusModuleMock
)
vi.mock(
  '../git/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)
vi.mock('../git/worktree', async () => (await import('./filesystem-test-harness')).gitWorktreeMock)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./filesystem-test-harness')).sshFilesystemDispatchMock
)
vi.mock(
  '../providers/ssh-git-dispatch',
  async () => (await import('./filesystem-test-harness')).sshGitDispatchMock
)
vi.mock(
  '../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../source-control/pull-request-linked-issue',
  async () => (await import('./filesystem-test-harness')).pullRequestLinkedIssueMock
)

import { registerFilesystemHandlers } from './filesystem'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'

describe('registerFilesystemHandlers', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    listMarkdownDocumentsMock.mockReset().mockResolvedValue([])
    localOptionsMock.mockReset().mockReturnValue({})
    // Reset module-level auth cache so each test starts with a fresh dirty
    // flag — prevents stale worktree data from a prior test's cache rebuild.
    invalidateAuthorizedRootsCache()
  })

  it('lists local documents through the bundled discovery path after authorization', async () => {
    const documents = [{ filePath: path.join(WORKTREE_FEATURE_PATH, 'README.md') }]
    listMarkdownDocumentsMock.mockResolvedValue(documents)
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, { rootPath: WORKTREE_FEATURE_PATH })
    ).resolves.toBe(documents)
    expect(localOptionsMock).toHaveBeenCalledWith(
      store,
      WORKTREE_FEATURE_PATH,
      WORKTREE_FEATURE_PATH
    )
    expect(listMarkdownDocumentsMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {})
    expect(readdirMock).not.toHaveBeenCalled()
  })

  it('rejects markdown document listing for authorized but unregistered roots', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: path.resolve('/workspace/unregistered')
      })
    ).rejects.toThrow('Access denied: unknown repository or worktree path')

    expect(readdirMock).not.toHaveBeenCalled()
    expect(listMarkdownDocumentsMock).not.toHaveBeenCalled()
  })

  it('lists remote markdown documents through the SSH filesystem provider', async () => {
    const provider = {
      listFiles: vi
        .fn()
        .mockResolvedValue(['README.md', 'docs/guide.mdx', '../outside.md', 'src/app.ts'])
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: '/home/user/project',
        connectionId: 'ssh-1'
      })
    ).resolves.toEqual([
      {
        filePath: '/home/user/project/docs/guide.mdx',
        relativePath: 'docs/guide.mdx',
        basename: 'guide.mdx',
        name: 'guide'
      },
      {
        filePath: '/home/user/project/README.md',
        relativePath: 'README.md',
        basename: 'README.md',
        name: 'README'
      }
    ])
    expect(listMarkdownDocumentsMock).not.toHaveBeenCalled()
    expect(localOptionsMock).not.toHaveBeenCalled()
  })
})
