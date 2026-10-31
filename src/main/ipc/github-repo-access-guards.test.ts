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

const { getIssue: getIssueMock, listWorkItems: listWorkItemsMock } = mocks.client
const { getAllWebContents: getAllWebContentsMock } = mocks.electron.webContents
const { sendToTrustedUIRenderer: sendToTrustedUIRendererMock } = mocks.ui

describe('registerGitHubHandlers', () => {
  const harness = createGitHubIpcHarness(mocks)
  const { handlers, store, stats } = harness

  beforeEach(harness.reset)

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

  it('rejects unknown repository paths', async () => {
    registerGitHubHandlers(store as never, stats as never)

    // Background issue reads are async (they check the repo's WSL distro first), so access errors reject.
    await expect(async () =>
      handlers['gh:issue'](null, {
        repoPath: '/workspace/other',
        number: 7
      })
    ).rejects.toThrow('Access denied: unknown repository path')

    expect(getIssueMock).not.toHaveBeenCalled()
  })

  it('rejects GitHub source context from a different host', async () => {
    registerGitHubHandlers(store as never, stats as never)

    await expect(async () =>
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
    ).rejects.toThrow('Access denied: GitHub source host does not match repository host')

    expect(listWorkItemsMock).not.toHaveBeenCalled()
  })
})
