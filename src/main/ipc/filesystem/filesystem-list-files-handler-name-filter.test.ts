import type * as WorktreeScanCacheModule from '../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handlers, store, resetFilesystemIpcMocks } from './filesystem-test-harness'

const { listQuickOpenFilesMock } = vi.hoisted(() => ({ listQuickOpenFilesMock: vi.fn() }))

vi.mock('../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const { listWorktreesMock } = await import('./filesystem-test-harness')
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktreeGraph: listWorktreesMock,
    listWorktrees: listWorktreesMock
  }
})

vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const { listWorktreesMock } = await import('./filesystem-test-harness')
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listWorktreesMock
  }
})

vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../../wsl/filesystem/wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock('../../git/source-control/commit-changes', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  commitChanges: (await import('./filesystem-test-harness')).commitChangesMock
}))

vi.mock('../../git/source-control/status-read', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStatus: (await import('./filesystem-test-harness')).getStatusMock
}))

vi.mock('../../git/source-control/git-conflict-operation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  detectConflictOperation: (await import('./filesystem-test-harness')).detectConflictOperationMock,
  abortMerge: (await import('./filesystem-test-harness')).abortMergeMock,
  abortRebase: (await import('./filesystem-test-harness')).abortRebaseMock
}))

vi.mock('../../git/source-control/file-diff', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDiff: (await import('./filesystem-test-harness')).getDiffMock
}))

vi.mock('../../git/source-control/branch-compare', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBranchCompare: (await import('./filesystem-test-harness')).getBranchCompareMock
}))

vi.mock('../../git/source-control/branch-diff', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBranchDiff: (await import('./filesystem-test-harness')).getBranchDiffMock
}))

vi.mock('../../git/source-control/staged-commit-context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStagedCommitContext: (await import('./filesystem-test-harness')).getStagedCommitContextMock
}))

vi.mock('../../git/source-control/staging', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stageFile: (await import('./filesystem-test-harness')).stageFileMock,
  bulkStageFiles: (await import('./filesystem-test-harness')).bulkStageFilesMock,
  stageWorktreeChanges: (await import('./filesystem-test-harness')).stageWorktreeChangesMock,
  unstageFile: (await import('./filesystem-test-harness')).unstageFileMock,
  bulkUnstageFiles: (await import('./filesystem-test-harness')).bulkUnstageFilesMock
}))

vi.mock('../../git/source-control/discard-changes', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bulkDiscardChanges: (await import('./filesystem-test-harness')).bulkDiscardChangesMock,
  discardChanges: (await import('./filesystem-test-harness')).discardChangesMock
}))
vi.mock(
  '../../git/source-control/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)

vi.mock(
  '../../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../../source-control/pull-request-linked-issue',
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

  it('returns no files for an SSH target and never lists locally', async () => {
    registerHandlers()

    await expect(
      handlers.get('fs:listFiles')!(null, { rootPath: '/home/user/repo', connectionId: 'conn-1' })
    ).resolves.toEqual([])
    expect(listQuickOpenFilesMock).not.toHaveBeenCalled()
  })

  // Workspace switches must cancel prior full-tree scans (#7721).
  it.each(['cancel', 'did-navigate', 'render-process-gone', 'destroyed'])(
    'aborts an in-flight file listing on %s (#7721)',
    async (eventName) => {
      let capturedSignal: AbortSignal | undefined
      listQuickOpenFilesMock.mockImplementation(
        (_rootPath: string, _store: unknown, _exclude: unknown, signal?: AbortSignal) =>
          new Promise<string[]>((_resolve, reject) => {
            capturedSignal = signal
            signal?.addEventListener('abort', () => reject(new Error('listing cancelled')), {
              once: true
            })
          })
      )
      registerHandlers()

      // Cancellation tokens belong to the issuing WebContents.
      const senderEvent = { sender: Object.assign(new EventEmitter(), { id: 7 }) }
      const pending = Promise.resolve(
        handlers.get('fs:listFiles')!(senderEvent, { rootPath: '/repo', requestToken: 'token-1' })
      )

      await Promise.resolve()
      expect(capturedSignal?.aborted).toBe(false)
      if (eventName === 'cancel') {
        await handlers.get('fs:cancelListFiles')!(senderEvent, { requestToken: 'token-1' })
      } else {
        senderEvent.sender.emit(eventName)
      }
      expect(capturedSignal?.aborted).toBe(true)
      await expect(pending).rejects.toThrow('listing cancelled')
      expect(senderEvent.sender.eventNames()).toEqual([])

      expect(() =>
        handlers.get('fs:cancelListFiles')!(senderEvent, { requestToken: 'unknown' })
      ).not.toThrow()
    }
  )
})
