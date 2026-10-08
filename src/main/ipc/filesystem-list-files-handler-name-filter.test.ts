import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handlers, store, resetFilesystemIpcMocks } from './filesystem-test-harness'

const { listQuickOpenFilesMock } = vi.hoisted(() => ({ listQuickOpenFilesMock: vi.fn() }))

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
vi.mock('./filesystem-list-files', () => ({ listQuickOpenFiles: listQuickOpenFilesMock }))

import { registerFilesystemHandlers } from './filesystem'

function registerHandlers(): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handlers under test only read repos and settings from the harness store.
  registerFilesystemHandlers(store as never)
}

describe('fs:listFiles local name filter', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    listQuickOpenFilesMock.mockReset().mockResolvedValue([])
  })

  it('filters the local scan with the Explorer word rule before the cap', async () => {
    registerHandlers()

    await handlers.get('fs:listFiles')!(null, {
      rootPath: '/repo',
      maxResults: 20_001,
      nameFilter: '  App   Delegate '
    })

    const [rootPath, , , , maxResults, , pathFilter] = listQuickOpenFilesMock.mock.calls[0]
    expect([rootPath, maxResults]).toEqual(['/repo', 20_001])
    expect(pathFilter('ios/Notion Web Clipper/AppDelegate.swift')).toBe(true)
    expect(pathFilter('ios/App.swift')).toBe(false)
  })

  it('lists unfiltered when the name filter is blank', async () => {
    registerHandlers()

    await handlers.get('fs:listFiles')!(null, { rootPath: '/repo', nameFilter: '   ' })

    expect(listQuickOpenFilesMock.mock.calls[0][6]).toBeUndefined()
  })

  it('refuses oversized name filters at the IPC boundary', async () => {
    registerHandlers()

    await expect(
      handlers.get('fs:listFiles')!(null, { rootPath: '/repo', nameFilter: 'x'.repeat(4096) })
    ).resolves.toEqual([])
    expect(listQuickOpenFilesMock).not.toHaveBeenCalled()
  })
})
