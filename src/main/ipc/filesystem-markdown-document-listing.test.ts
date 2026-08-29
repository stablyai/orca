import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  dirEntry,
  WORKTREE_FEATURE_PATH,
  readdirMock,
  getSshFilesystemProviderMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

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
    // Reset module-level auth cache so each test starts with a fresh dirty
    // flag — prevents stale worktree data from a prior test's cache rebuild.
    invalidateAuthorizedRootsCache()
  })

  it('lists markdown documents recursively for a registered worktree', async () => {
    readdirMock.mockImplementation(async (dirPath: string) => {
      if (dirPath === WORKTREE_FEATURE_PATH) {
        return [
          dirEntry({ name: 'README.md', file: true }),
          dirEntry({ name: 'docs', directory: true }),
          dirEntry({ name: 'script.ts', file: true })
        ]
      }
      if (dirPath === path.join(WORKTREE_FEATURE_PATH, 'docs')) {
        return [
          dirEntry({ name: 'Guide.MDX', file: true }),
          dirEntry({ name: 'notes.markdown', file: true })
        ]
      }
      return []
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual([
      {
        filePath: path.join(WORKTREE_FEATURE_PATH, 'docs', 'Guide.MDX'),
        relativePath: 'docs/Guide.MDX',
        basename: 'Guide.MDX',
        name: 'Guide'
      },
      {
        filePath: path.join(WORKTREE_FEATURE_PATH, 'docs', 'notes.markdown'),
        relativePath: 'docs/notes.markdown',
        basename: 'notes.markdown',
        name: 'notes'
      },
      {
        filePath: path.join(WORKTREE_FEATURE_PATH, 'README.md'),
        relativePath: 'README.md',
        basename: 'README.md',
        name: 'README'
      }
    ])
  })

  it('skips ignored and symlinked directories when listing markdown documents', async () => {
    readdirMock.mockImplementation(async (dirPath: string) => {
      if (dirPath === WORKTREE_FEATURE_PATH) {
        return [
          dirEntry({ name: '.git', directory: true }),
          dirEntry({ name: '.hidden', directory: true }),
          dirEntry({ name: '.github', directory: true }),
          dirEntry({ name: 'node_modules', directory: true }),
          dirEntry({ name: 'linked-docs', directory: true, symlink: true }),
          dirEntry({ name: 'visible.md', file: true })
        ]
      }
      if (dirPath === path.join(WORKTREE_FEATURE_PATH, '.github')) {
        return [dirEntry({ name: 'CONTRIBUTING.md', file: true })]
      }
      throw new Error(`Unexpected readdir: ${dirPath}`)
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual([
      {
        filePath: path.join(WORKTREE_FEATURE_PATH, '.github', 'CONTRIBUTING.md'),
        relativePath: '.github/CONTRIBUTING.md',
        basename: 'CONTRIBUTING.md',
        name: 'CONTRIBUTING'
      },
      {
        filePath: path.join(WORKTREE_FEATURE_PATH, 'visible.md'),
        relativePath: 'visible.md',
        basename: 'visible.md',
        name: 'visible'
      }
    ])
  })

  it('rejects markdown document listing for authorized but unregistered roots', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: path.resolve('/workspace/unregistered')
      })
    ).rejects.toThrow('Access denied: unknown repository or worktree path')

    expect(readdirMock).not.toHaveBeenCalled()
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
  })
})
