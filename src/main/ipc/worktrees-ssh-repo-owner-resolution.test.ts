import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import type { ProviderRequestId } from '../../shared/detected-worktree-provider-contract'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../shared/execution-host'
import { getSshProviderAuthority } from '../ssh/ssh-provider-authority'
import {
  listWorktreesMock,
  getSshGitProviderMock,
  pruneCleanupScanSnapshotsMock,
  pruneSpaceAnalysisSnapshotsMock
} from './worktrees-test-module-mocks'
import { handlers, ipcEvent, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { makeWorktreeMeta } from './worktrees-test-fixtures'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('../providers/ssh-git-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshGitDispatchModuleMock()
)
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('./ssh', async () => (await import('./worktrees-test-module-mocks')).sshModuleMock())
vi.mock('../ssh/ssh-target-registry', async () =>
  (await import('./worktrees-test-module-mocks')).sshTargetRegistryModuleMock()
)
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

describe('registerWorktreeHandlers', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  it('selects the exact SSH repo owner when repo IDs collide across hosts', async () => {
    const sshHostId = toSshExecutionHostId('target-a')
    const localRepo = {
      id: 'shared-repo',
      path: '/local/repo',
      displayName: 'local repo',
      badgeColor: '#000',
      addedAt: 0
    }
    const sshRepo = {
      ...localRepo,
      path: '/remote/repo',
      displayName: 'remote repo',
      connectionId: 'target-a'
    }
    const provider = { listWorktrees: vi.fn().mockResolvedValue([]) }
    store.getRepos.mockImplementation(() => [{ ...localRepo }, { ...sshRepo }])
    getSshGitProviderMock.mockImplementation((targetId) =>
      targetId === 'target-a' ? provider : undefined
    )
    const expectedAuthority = getSshProviderAuthority('target-a')

    const result = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: 'request-1' as ProviderRequestId,
      repoId: 'shared-repo',
      executionHostId: sshHostId,
      expectedAuthority
    })

    expect(provider.listWorktrees).toHaveBeenCalledWith('/remote/repo', {
      signal: expect.any(AbortSignal)
    })
    expect(result).toEqual({
      status: 'complete',
      providerRequestId: 'request-1',
      repoId: 'shared-repo',
      authority: {
        kind: 'direct-ssh',
        executionHostId: sshHostId,
        ...expectedAuthority
      },
      result: {
        repoId: 'shared-repo',
        authoritative: true,
        source: 'git',
        worktrees: []
      }
    })
  })

  it('rejects malformed and contradictory repo host provenance', async () => {
    const provider = { listWorktrees: vi.fn().mockResolvedValue([]) }
    getSshGitProviderMock.mockReturnValue(provider)
    const request = {
      providerRequestId: 'request-1' as ProviderRequestId,
      repoId: 'repo-1',
      executionHostId: toSshExecutionHostId('target-a'),
      expectedAuthority: getSshProviderAuthority('target-a')
    }
    const baseRepo = {
      id: 'repo-1',
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'target-a'
    }

    store.getRepos.mockReturnValue([{ ...baseRepo, executionHostId: 'ssh:%' }])
    const malformed = await handlers['worktrees:listDetected'](ipcEvent, request)

    store.getRepos.mockReturnValue([
      {
        ...baseRepo,
        executionHostId: toSshExecutionHostId('target-b')
      }
    ])
    const contradictory = await handlers['worktrees:listDetected'](ipcEvent, request)

    expect(malformed).toMatchObject({
      status: 'rejected',
      providerRequestId: 'request-1',
      executionHostId: 'ssh:target-a'
    })
    expect(contradictory).toMatchObject({
      status: 'rejected',
      providerRequestId: 'request-1',
      executionHostId: 'ssh:target-a'
    })
    expect(provider.listWorktrees).not.toHaveBeenCalled()
  })

  it('returns a local discriminant without SSH authority fields', async () => {
    listWorktreesMock.mockResolvedValue([])

    const result = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: 'request-1' as ProviderRequestId,
      repoId: 'repo-1',
      executionHostId: 'local'
    })

    expect(result).toEqual({
      status: 'complete',
      providerRequestId: 'request-1',
      repoId: 'repo-1',
      authority: { kind: 'local', executionHostId: 'local' },
      result: {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: []
      }
    })
  })

  it('includes the full SSH authority on non-authoritative data', async () => {
    const sshRepo = {
      id: 'repo-1',
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'target-a'
    }
    store.getRepos.mockReturnValue([sshRepo])
    getSshGitProviderMock.mockReturnValue(undefined)
    const expectedAuthority = getSshProviderAuthority('target-a')

    const result = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: 'request-1' as ProviderRequestId,
      repoId: sshRepo.id,
      executionHostId: toSshExecutionHostId('target-a'),
      expectedAuthority
    })

    expect(result).toEqual({
      status: 'non-authoritative',
      providerRequestId: 'request-1',
      repoId: 'repo-1',
      authority: {
        kind: 'direct-ssh',
        executionHostId: 'ssh:target-a',
        ...expectedAuthority
      },
      result: {
        repoId: 'repo-1',
        authoritative: false,
        source: 'metadata-fallback',
        worktrees: []
      }
    })
  })

  it('lists every persisted SSH worktree without accessing the live provider', async () => {
    const sshHostId = toSshExecutionHostId('target-a')
    const sshRepo = {
      id: 'repo-1',
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'target-a'
    }
    const metaById = {
      'repo-1::/remote/repo': makeWorktreeMeta({
        displayName: 'main',
        hostId: sshHostId
      }),
      'repo-1::/remote/queued': makeWorktreeMeta({
        displayName: 'queued',
        hostId: sshHostId
      }),
      'repo-1::/remote/other-host': makeWorktreeMeta({
        displayName: 'other host',
        hostId: toSshExecutionHostId('target-b')
      })
    }
    store.getRepos.mockReturnValue([sshRepo])
    store.getProjectHostSetups.mockReturnValue([])
    store.getAllWorktreeMeta.mockReturnValue(metaById)
    store.getWorktreeMeta.mockImplementation((worktreeId: string) => metaById[worktreeId])

    const result = await handlers['worktrees:listKnownForExecutionHost'](null, {
      repoId: sshRepo.id,
      executionHostId: sshHostId
    })

    expect(result).toMatchObject({
      status: 'complete',
      repoId: sshRepo.id,
      executionHostId: sshHostId,
      result: {
        repoId: sshRepo.id,
        authoritative: false,
        source: 'metadata-fallback',
        worktrees: [
          expect.objectContaining({ path: '/remote/repo', isMainWorktree: true }),
          expect.objectContaining({ path: '/remote/queued', isMainWorktree: false })
        ]
      }
    })
    expect(getSshGitProviderMock).not.toHaveBeenCalled()
    expect(listWorktreesMock).not.toHaveBeenCalled()
  })

  it('lists SSH folder workspaces at the folder path, not the instance-suffixed id', async () => {
    const sshHostId = toSshExecutionHostId('target-a')
    const folderRepo = {
      id: 'repo-1',
      path: '/remote/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'target-a',
      kind: 'folder' as const
    }
    const rootId = `${folderRepo.id}::${folderRepo.path}`
    const instanceId = `${rootId}::workspace:11111111-2222-3333-4444-555555555555`
    const metaById = {
      [rootId]: makeWorktreeMeta({ displayName: 'root', hostId: sshHostId }),
      [instanceId]: makeWorktreeMeta({
        displayName: 'second workspace',
        hostId: sshHostId,
        instanceId: '11111111-2222-3333-4444-555555555555'
      })
    }
    store.getRepos.mockReturnValue([folderRepo])
    store.getProjectHostSetups.mockReturnValue([])
    store.getAllWorktreeMeta.mockReturnValue(metaById)
    store.getWorktreeMeta.mockImplementation((worktreeId: string) => metaById[worktreeId])

    const result = (await handlers['worktrees:listKnownForExecutionHost'](null, {
      repoId: folderRepo.id,
      executionHostId: sshHostId
    })) as { status: string; result: { authoritative: boolean; worktrees: Worktree[] } }

    expect(result.status).toBe('complete')
    expect(result.result.authoritative).toBe(false)
    // Why: the git-worktree synthesizer would read the "::workspace:<uuid>" tail as a directory.
    expect(result.result.worktrees).toEqual([
      expect.objectContaining({ id: rootId, path: folderRepo.path, isMainWorktree: true }),
      expect.objectContaining({ id: instanceId, path: folderRepo.path, isMainWorktree: false })
    ])
    expect(getSshGitProviderMock).not.toHaveBeenCalled()
  })

  it('stops listing SSH worktrees once an authoritative scan retires their metadata', async () => {
    const sshHostId = toSshExecutionHostId('target-a')
    const sshRepo = {
      id: 'repo-1',
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'target-a'
    }
    const metaById: Record<string, Record<string, unknown>> = {
      'repo-1::/remote/repo': makeWorktreeMeta({ displayName: 'main', hostId: sshHostId }),
      'repo-1::/remote/deleted': makeWorktreeMeta({ displayName: 'deleted', hostId: sshHostId }),
      'repo-1::/remote/deleted-too': makeWorktreeMeta({
        displayName: 'deleted too',
        hostId: sshHostId
      }),
      'repo-1::/remote/other-host': makeWorktreeMeta({
        displayName: 'other host',
        hostId: toSshExecutionHostId('target-b')
      }),
      'repo-2::/remote/other-repo': makeWorktreeMeta({ displayName: 'other repo' })
    }
    store.getRepos.mockReturnValue([sshRepo])
    store.getProjectHostSetups.mockReturnValue([])
    store.getAllWorktreeMeta.mockReturnValue(metaById)
    store.getWorktreeMeta.mockImplementation((worktreeId: string) => metaById[worktreeId])
    store.removeWorktreeMeta.mockImplementation((worktreeId: string) => {
      delete metaById[worktreeId]
    })

    const forgotten = await handlers['worktrees:forgetRemovedForExecutionHost'](null, {
      repoId: sshRepo.id,
      executionHostId: sshHostId,
      // Only the first two are this host's rows; the rest must survive an over-broad request.
      worktreeIds: [
        'repo-1::/remote/deleted',
        'repo-1::/remote/deleted-too',
        'repo-1::/remote/other-host',
        'repo-2::/remote/other-repo',
        'repo-1::/remote/never-persisted'
      ]
    })

    expect(forgotten).toEqual({
      forgottenWorktreeIds: ['repo-1::/remote/deleted', 'repo-1::/remote/deleted-too']
    })
    expect(store.removeWorktreeMeta).toHaveBeenCalledTimes(2)
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith('repo-1::/remote/deleted', sshHostId)
    const pruneTargets = [
      { worktreeId: 'repo-1::/remote/deleted', executionHostId: sshHostId },
      { worktreeId: 'repo-1::/remote/deleted-too', executionHostId: sshHostId }
    ]
    expect(pruneCleanupScanSnapshotsMock).toHaveBeenCalledExactlyOnceWith(
      '/profile-a',
      pruneTargets
    )
    expect(pruneSpaceAnalysisSnapshotsMock).toHaveBeenCalledExactlyOnceWith(
      '/profile-a',
      pruneTargets
    )

    // Why: the renderer's suppression memory is session-scoped, so the next launch must not re-list the row.
    const relisted = (await handlers['worktrees:listKnownForExecutionHost'](null, {
      repoId: sshRepo.id,
      executionHostId: sshHostId
    })) as { result: { worktrees: { path: string }[] } }

    expect(relisted.result.worktrees.map((worktree) => worktree.path)).toEqual(['/remote/repo'])
  })

  it('never retires folder workspace metadata, which is the workspace record itself', async () => {
    const sshHostId = toSshExecutionHostId('target-a')
    const folderRepo = {
      id: 'repo-1',
      path: '/remote/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'target-a',
      kind: 'folder' as const
    }
    const instanceId = `${folderRepo.id}::${folderRepo.path}::workspace:11111111-2222-3333-4444-555555555555`
    store.getRepos.mockReturnValue([folderRepo])
    store.getAllWorktreeMeta.mockReturnValue({
      [instanceId]: makeWorktreeMeta({ displayName: 'second workspace', hostId: sshHostId })
    })

    const forgotten = await handlers['worktrees:forgetRemovedForExecutionHost'](null, {
      repoId: folderRepo.id,
      executionHostId: sshHostId,
      worktreeIds: [instanceId]
    })

    expect(forgotten).toEqual({ forgottenWorktreeIds: [] })
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  // Runtime-host rows are exempt from gcStaleWorktreeMeta exactly as SSH ones are, so a paired
  // client needs this path to ever drop them (#17776).
  it('retires runtime-host metadata an authoritative scan proved gone', async () => {
    const runtimeHostId = toRuntimeExecutionHostId('env-1')
    const runtimeRepo = {
      id: 'repo-1',
      path: '/home/orca/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      executionHostId: runtimeHostId
    }
    const metaById: Record<string, ReturnType<typeof makeWorktreeMeta>> = {
      'repo-1::/home/orca/deleted': makeWorktreeMeta({ hostId: runtimeHostId }),
      'repo-1::/home/orca/other-host': makeWorktreeMeta({
        hostId: toSshExecutionHostId('target-a')
      })
    }
    store.getRepos.mockReturnValue([runtimeRepo])
    store.getProjectHostSetups.mockReturnValue([])
    store.getAllWorktreeMeta.mockReturnValue(metaById)
    store.removeWorktreeMeta.mockImplementation((worktreeId: string) => {
      delete metaById[worktreeId]
    })

    const forgotten = await handlers['worktrees:forgetRemovedForExecutionHost'](null, {
      repoId: runtimeRepo.id,
      executionHostId: runtimeHostId,
      worktreeIds: ['repo-1::/home/orca/deleted', 'repo-1::/home/orca/other-host']
    })

    // The row stamped to another host needs that host's own scan, not this one's.
    expect(forgotten).toEqual({ forgottenWorktreeIds: ['repo-1::/home/orca/deleted'] })
    expect(store.removeWorktreeMeta).toHaveBeenCalledExactlyOnceWith(
      'repo-1::/home/orca/deleted',
      runtimeHostId
    )
  })

  // A repo that reaches its checkouts over SSH is not the runtime host's to condemn. The refusal
  // comes from `findExactRepoOwner`: a runtime `executionHostId` beside a `connectionId` is
  // contradictory ownership evidence, so no owner resolves at all.
  it('refuses to retire a connection-backed repo under a runtime host id', async () => {
    const runtimeHostId = toRuntimeExecutionHostId('env-1')
    store.getRepos.mockReturnValue([
      {
        id: 'repo-1',
        path: '/home/orca/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        executionHostId: runtimeHostId,
        connectionId: 'target-a'
      }
    ])
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-1::/home/orca/deleted': makeWorktreeMeta({ hostId: runtimeHostId })
    })

    expect(
      await handlers['worktrees:forgetRemovedForExecutionHost'](null, {
        repoId: 'repo-1',
        executionHostId: runtimeHostId,
        worktreeIds: ['repo-1::/home/orca/deleted']
      })
    ).toEqual({ forgottenWorktreeIds: [] })
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('refuses to retire metadata for non-executing hosts and unowned repos', async () => {
    const sshRepo = {
      id: 'repo-1',
      path: '/remote/repo-a',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'target-a'
    }
    store.getRepos.mockReturnValue([sshRepo, { ...sshRepo, path: '/remote/repo-b' }])
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-1::/remote/deleted': makeWorktreeMeta({})
    })

    expect(
      await handlers['worktrees:forgetRemovedForExecutionHost'](null, {
        repoId: sshRepo.id,
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        worktreeIds: ['repo-1::/remote/deleted']
      })
    ).toEqual({ forgottenWorktreeIds: [] })
    // Ambiguous SSH ownership fails closed the same way the metadata read does.
    expect(
      await handlers['worktrees:forgetRemovedForExecutionHost'](null, {
        repoId: sshRepo.id,
        executionHostId: toSshExecutionHostId('target-a'),
        worktreeIds: ['repo-1::/remote/deleted']
      })
    ).toEqual({ forgottenWorktreeIds: [] })
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('rejects metadata-only reads for non-SSH execution hosts', async () => {
    const result = await handlers['worktrees:listKnownForExecutionHost'](null, {
      repoId: 'repo-1',
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })

    expect(result).toEqual({
      status: 'rejected',
      repoId: 'repo-1',
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    expect(store.getRepos).not.toHaveBeenCalled()
  })

  it('rejects ambiguous metadata-only SSH owners', async () => {
    const sshHostId = toSshExecutionHostId('target-a')
    const sshRepo = {
      id: 'repo-1',
      path: '/remote/repo-a',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'target-a'
    }
    store.getRepos.mockReturnValue([sshRepo, { ...sshRepo, path: '/remote/repo-b' }])

    const result = await handlers['worktrees:listKnownForExecutionHost'](null, {
      repoId: sshRepo.id,
      executionHostId: sshHostId
    })

    expect(result).toEqual({
      status: 'rejected',
      repoId: sshRepo.id,
      executionHostId: sshHostId
    })
    expect(store.getAllWorktreeMeta).not.toHaveBeenCalled()
    expect(getSshGitProviderMock).not.toHaveBeenCalled()
  })

  it('fails closed for duplicate exact owners and ambiguous legacy repo IDs', async () => {
    const sshRepo = {
      id: 'shared-repo',
      path: '/remote/repo-a',
      displayName: 'remote repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'target-a'
    }
    const duplicateSshRepo = { ...sshRepo, path: '/remote/repo-b' }
    const localRepo = { ...sshRepo, path: '/local/repo', connectionId: undefined }
    store.getRepos.mockReturnValue([sshRepo, duplicateSshRepo, localRepo])
    const expectedAuthority = getSshProviderAuthority('target-a')

    const qualified = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: 'request-1' as ProviderRequestId,
      repoId: 'shared-repo',
      executionHostId: toSshExecutionHostId('target-a'),
      expectedAuthority
    })
    const legacy = await handlers['worktrees:listDetected'](null, { repoId: 'shared-repo' })

    expect(qualified).toMatchObject({
      status: 'ambiguous-owner',
      providerRequestId: 'request-1',
      executionHostId: 'ssh:target-a'
    })
    expect(legacy).toEqual({
      repoId: 'shared-repo',
      authoritative: false,
      source: 'metadata-fallback',
      worktrees: []
    })
    expect(getSshGitProviderMock).not.toHaveBeenCalled()
    expect(listWorktreesMock).not.toHaveBeenCalled()
  })

  it('does not prune another host lineage when repo IDs collide', async () => {
    const sshARepo = {
      id: 'shared-repo',
      path: '/remote/repo-a',
      displayName: 'remote repo A',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'target-a'
    }
    const sshBRepo = {
      ...sshARepo,
      path: '/remote/repo-b',
      displayName: 'remote repo B',
      connectionId: 'target-b'
    }
    const childId = 'shared-repo::/remote/repo-b/feature'
    store.getRepos.mockReturnValue([sshARepo, sshBRepo])
    store.getWorktreeMeta.mockImplementation((worktreeId: string) =>
      worktreeId === childId
        ? makeWorktreeMeta({ hostId: toSshExecutionHostId('target-b') })
        : undefined
    )
    store.getAllWorktreeLineage.mockReturnValue({
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: 'shared-repo::/remote/repo-b',
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 0
      }
    })
    getSshGitProviderMock.mockReturnValue({ listWorktrees: vi.fn().mockResolvedValue([]) })
    const expectedAuthority = getSshProviderAuthority('target-a')

    const result = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: 'request-1' as ProviderRequestId,
      repoId: 'shared-repo',
      executionHostId: toSshExecutionHostId('target-a'),
      expectedAuthority
    })

    expect(result).toMatchObject({ status: 'complete' })
    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('preserves conflicting host metadata instead of backfilling it', async () => {
    const sshARepo = {
      id: 'shared-repo',
      path: '/remote/repo-a',
      displayName: 'remote repo A',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'target-a'
    }
    const sshBRepo = { ...sshARepo, path: '/remote/repo-b', connectionId: 'target-b' }
    const worktreePath = '/remote/shared-feature'
    store.getRepos.mockReturnValue([sshARepo, sshBRepo])
    store.getWorktreeMeta.mockImplementation((worktreeId: string) =>
      worktreeId === `shared-repo::${worktreePath}`
        ? makeWorktreeMeta({ hostId: toSshExecutionHostId('target-b') })
        : undefined
    )
    getSshGitProviderMock.mockReturnValue({
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: worktreePath,
          head: 'head-a',
          branch: 'refs/heads/feature',
          isBare: false,
          isMainWorktree: false
        }
      ])
    })

    const result = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: 'request-1' as ProviderRequestId,
      repoId: 'shared-repo',
      executionHostId: toSshExecutionHostId('target-a'),
      expectedAuthority: getSshProviderAuthority('target-a')
    })

    expect(result).toMatchObject({
      status: 'non-authoritative',
      result: { authoritative: false, worktrees: [] }
    })
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
  })

  it('rejects runtime hosts, wrong SSH targets, and missing authority', async () => {
    const requestId = 'request-1' as ProviderRequestId
    const expectedAuthority = getSshProviderAuthority('target-a')

    const runtimeResult = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: requestId,
      repoId: 'repo-1',
      executionHostId: 'runtime:runtime-a'
    })
    const wrongTargetResult = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: requestId,
      repoId: 'repo-1',
      executionHostId: toSshExecutionHostId('target-b'),
      expectedAuthority
    })
    const missingAuthorityResult = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: requestId,
      repoId: 'repo-1',
      executionHostId: toSshExecutionHostId('target-a')
    })
    const zeroOwnerResult = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: requestId,
      repoId: 'repo-1',
      executionHostId: toSshExecutionHostId('target-a'),
      expectedAuthority
    })
    store.getRepos.mockReturnValue([
      {
        id: 'repo-1',
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'target-b',
        executionHostId: toSshExecutionHostId('target-a')
      }
    ])
    const wrongProviderOwnerResult = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: requestId,
      repoId: 'repo-1',
      executionHostId: toSshExecutionHostId('target-a'),
      expectedAuthority
    })

    expect(runtimeResult).toMatchObject({ status: 'rejected' })
    expect(wrongTargetResult).toMatchObject({ status: 'rejected' })
    expect(missingAuthorityResult).toMatchObject({ status: 'rejected' })
    expect(zeroOwnerResult).toMatchObject({ status: 'ambiguous-owner' })
    expect(wrongProviderOwnerResult).toMatchObject({ status: 'rejected' })
    expect(getSshGitProviderMock).not.toHaveBeenCalled()
    expect(listWorktreesMock).not.toHaveBeenCalled()
  })

  it('rejects a provider replacement during the SSH await without durable mutations', async () => {
    let resolveList: (worktrees: GitWorktreeInfo[]) => void = () => {}
    const firstProvider = {
      listWorktrees: vi.fn(
        () =>
          new Promise<GitWorktreeInfo[]>((resolve) => {
            resolveList = resolve
          })
      )
    }
    const replacementProvider = { listWorktrees: vi.fn().mockResolvedValue([]) }
    let currentProvider = firstProvider
    const sshRepo = {
      id: 'repo-1',
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'target-a'
    }
    store.getRepos.mockReturnValue([sshRepo])
    getSshGitProviderMock.mockImplementation(() => currentProvider)
    const expectedAuthority = getSshProviderAuthority('target-a')

    const pending = handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: 'request-1' as ProviderRequestId,
      repoId: sshRepo.id,
      executionHostId: toSshExecutionHostId('target-a'),
      expectedAuthority
    })
    await Promise.resolve()
    currentProvider = replacementProvider
    resolveList([
      {
        path: '/remote/repo',
        head: 'stale-head',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])

    await expect(pending).resolves.toMatchObject({ status: 'stale' })
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
  })
})
