import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MarkdownDocumentsModule from './markdown-documents'
import {
  handlers,
  store,
  WORKTREE_FEATURE_PATH,
  readdirMock,
  realpathMock,
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

  it('exposes registered alias paths that remain readable and rejects child symlink escapes', async () => {
    const alias = path.resolve('/alias-folder')
    const canonical = path.resolve('/canonical-folder')
    const outside = path.resolve('/outside/secret.md')
    const folderStore = {
      ...store,
      getFolderWorkspaces: () => [{ id: 'folder', folderPath: alias, projectGroupId: 'group' }]
    }
    realpathMock.mockImplementation(async (target: string) =>
      target === path.join(alias, 'escape.md')
        ? outside
        : target === alias || target.startsWith(alias + path.sep)
          ? canonical + target.slice(alias.length)
          : target
    )
    listMarkdownDocumentsMock.mockResolvedValue([
      {
        filePath: path.join(canonical, 'Target.md'),
        relativePath: 'Target.md',
        basename: 'Target.md',
        name: 'Target'
      }
    ])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This IPC fixture implements the store reads used by filesystem authorization.
    registerFilesystemHandlers(folderStore as never)
    const documents = await handlers.get('fs:listMarkdownDocuments')!(null, { rootPath: alias })
    expect(documents).toEqual([
      {
        filePath: path.join(alias, 'Target.md'),
        relativePath: 'Target.md',
        basename: 'Target.md',
        name: 'Target'
      }
    ])
    expect(listMarkdownDocumentsMock).toHaveBeenCalledWith(canonical, {})
    await expect(
      handlers.get('fs:readFile')!(null, { filePath: path.join(alias, 'Target.md') })
    ).resolves.toEqual({ content: 'a'.repeat(10), isBinary: false })
    await expect(
      handlers.get('fs:stat')!(null, { filePath: path.join(alias, 'Target.md') })
    ).resolves.toHaveProperty('isDirectory', false)
    await expect(
      handlers.get('fs:readFile')!(null, { filePath: path.join(alias, 'escape.md') })
    ).rejects.toThrow('Access denied')
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

  it('keeps late Markdown documents from legacy providers with large source inventories', async () => {
    const paths = Array.from({ length: 25_002 }, (_, index) => `src/file-${index}.ts`)
    paths.push('docs/late.md')
    const provider = { listFiles: vi.fn().mockResolvedValue(paths) }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the store reads used by filesystem handler registration.
    registerFilesystemHandlers(store as never)
    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: '/repo',
        connectionId: 'legacy'
      })
    ).resolves.toEqual([
      {
        filePath: '/repo/docs/late.md',
        relativePath: 'docs/late.md',
        basename: 'late.md',
        name: 'late'
      }
    ])
    expect(provider.listFiles).toHaveBeenCalledWith('/repo')
  })

  it('still bounds legacy source inventories before constructing Markdown metadata', async () => {
    getSshFilesystemProviderMock.mockReturnValue({
      listFiles: vi.fn().mockResolvedValue([`${'x'.repeat(65_537)}.ts`, 'README.md'])
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the store reads used by filesystem handler registration.
    registerFilesystemHandlers(store as never)
    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: '/repo',
        connectionId: 'legacy'
      })
    ).rejects.toThrow('File inventory is too large')
  })
})
