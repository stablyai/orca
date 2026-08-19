import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createGitHubIpcMocks } = await import('./github-ipc-module-mocks')
  return createGitHubIpcMocks()
})

vi.mock('electron', () => mocks.electron)
vi.mock('../github/client', () => mocks.client)
vi.mock('../github/work-item-details', () => mocks.workItemDetails)
vi.mock('../github/pr-refresh-coordinator', () => mocks.prRefresh)
vi.mock('../telemetry/client', () => mocks.telemetry)
vi.mock('../telemetry/cohort-classifier', () => mocks.cohort)
vi.mock('./ui', () => mocks.ui)

import { registerGitHubHandlers } from './github'
import { createGitHubIpcHarness } from './github-ipc-test-harness'

const {
  getPRForBranch: getPRForBranchMock,
  getIssue: getIssueMock,
  listWorkItems: listWorkItemsMock,
  listLabels: listLabelsMock,
  setPRFileViewed: setPRFileViewedMock
} = mocks.client
const { getAllWebContents: getAllWebContentsMock } = mocks.electron.webContents
const { sendToTrustedUIRenderer: sendToTrustedUIRendererMock } = mocks.ui

describe('registerGitHubHandlers', () => {
  const harness = createGitHubIpcHarness(mocks)
  const { handlers, store, stats } = harness

  beforeEach(harness.reset)

  it('normalizes registered repo paths before invoking github clients', async () => {
    getPRForBranchMock.mockResolvedValue({ number: 42 })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:prForBranch'](null, {
      repoPath: '/workspace/repo/../repo',
      branch: 'feature/test'
    })

    expect(getPRForBranchMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'feature/test',
      null,
      null,
      null
    )
  })

  it('targets mutation notifications without broadcasting to 100 browser guests', async () => {
    const guestSends = Array.from({ length: 100 }, () => vi.fn())
    getAllWebContentsMock.mockReturnValue(
      guestSends.map((send, index) => ({
        id: index + 100,
        isDestroyed: () => false,
        send
      }))
    )
    registerGitHubHandlers(store as never, stats as never)

    const result = await handlers['gh:notifyWorkItemMutated'](
      { sender: { id: 1 } },
      {
        repoPath: '/home/runtime/repo',
        repoId: 'repo-1',
        type: 'pr',
        number: 42
      }
    )

    expect(result).toBe(true)
    expect(sendToTrustedUIRendererMock).toHaveBeenCalledOnce()
    expect(sendToTrustedUIRendererMock).toHaveBeenCalledWith(
      'gh:workItemMutated',
      {
        repoPath: '/workspace/repo',
        repoId: 'repo-1',
        type: 'pr',
        number: 42
      },
      1
    )
    expect(getAllWebContentsMock).not.toHaveBeenCalled()
    expect(guestSends.reduce((total, send) => total + send.mock.calls.length, 0)).toBe(0)
  })

  it('targets mutation notifications with resolved repo id when called by repo path', async () => {
    registerGitHubHandlers(store as never, stats as never)

    const result = await handlers['gh:notifyWorkItemMutated'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        type: 'issue',
        number: 7
      }
    )

    expect(result).toBe(true)
    expect(sendToTrustedUIRendererMock).toHaveBeenCalledWith(
      'gh:workItemMutated',
      {
        repoPath: '/workspace/repo',
        repoId: 'repo-1',
        type: 'issue',
        number: 7
      },
      1
    )
  })

  it('targets PR file viewed mutations with repo id for cache invalidation', async () => {
    setPRFileViewedMock.mockResolvedValue(true)
    registerGitHubHandlers(store as never, stats as never)

    const result = await handlers['gh:setPRFileViewed'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        pullRequestId: 'PR_kw',
        path: 'src/app.ts',
        viewed: true
      }
    )

    expect(result).toBe(true)
    expect(sendToTrustedUIRendererMock).toHaveBeenCalledWith(
      'gh:workItemMutated',
      {
        repoPath: '/workspace/repo',
        repoId: 'repo-1',
        type: 'pr',
        number: 42
      },
      1
    )
  })

  it('rejects unknown repository paths', async () => {
    registerGitHubHandlers(store as never, stats as never)

    expect(() =>
      handlers['gh:issue'](null, {
        repoPath: '/workspace/other',
        number: 7
      })
    ).toThrow('Access denied: unknown repository path')

    expect(getIssueMock).not.toHaveBeenCalled()
  })

  it('rejects GitHub source context from a different host', async () => {
    registerGitHubHandlers(store as never, stats as never)

    expect(() =>
      handlers['gh:listWorkItems'](null, {
        repoPath: '/workspace/repo',
        sourceContext: {
          kind: 'task-source',
          provider: 'github',
          projectId: 'project-1',
          hostId: 'ssh:openclaw-2',
          repoId: 'repo-1'
        }
      })
    ).toThrow('Access denied: GitHub source host does not match repository host')

    expect(listWorkItemsMock).not.toHaveBeenCalled()
  })

  it('guards label metadata lookups with source host context', async () => {
    listLabelsMock.mockResolvedValue(['bug'])
    harness.repos = [
      ...harness.repos,
      {
        id: 'repo-ssh',
        path: '/workspace/remote-repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'openclaw-2',
        executionHostId: 'ssh:openclaw-2'
      }
    ]
    registerGitHubHandlers(store as never, stats as never)

    await expect(
      handlers['gh:listLabels'](null, {
        repoPath: '/workspace/remote-repo',
        repoId: 'repo-ssh',
        sourceContext: {
          kind: 'task-source',
          provider: 'github',
          projectId: 'project-1',
          hostId: 'ssh:openclaw-2',
          repoId: 'repo-ssh'
        }
      })
    ).resolves.toEqual(['bug'])

    expect(listLabelsMock).toHaveBeenCalledWith('/workspace/remote-repo', undefined, 'openclaw-2')
  })
})
