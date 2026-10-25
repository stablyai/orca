import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MarkdownDocumentsModule from './markdown-documents'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../providers/ssh-host-not-served-error'
import {
  handlers,
  store,
  WORKTREE_FEATURE_PATH,
  readdirMock,
  realpathMock,
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
  '../git/status',
  async () => (await import('./filesystem-test-harness')).gitStatusModuleMock
)
vi.mock(
  '../git/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)
vi.mock('../git/worktree', async () => (await import('./filesystem-test-harness')).gitWorktreeMock)
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
    // Drop cached roots between fixtures.
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

  it('refuses SSH markdown listing as not served and never lists locally', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: '/home/user/project',
        connectionId: 'ssh-1'
      })
    ).rejects.toThrow(SSH_HOST_NOT_SERVED_MESSAGE)
    expect(listMarkdownDocumentsMock).not.toHaveBeenCalled()
    expect(localOptionsMock).not.toHaveBeenCalled()
  })
})
