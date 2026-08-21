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
  listWorkItems: listWorkItemsMock,
  mergePR: mergePRMock,
  setPRAutoMerge: setPRAutoMergeMock
} = mocks.client

describe('registerGitHubHandlers', () => {
  const harness = createGitHubIpcHarness(mocks)
  const { handlers, store, stats } = harness

  beforeEach(harness.reset)

  it('threads SSH connectionId through GitHub work-item handlers', async () => {
    harness.repos[0].connectionId = 'openclaw-2'
    listWorkItemsMock.mockResolvedValue({ items: [] })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:listWorkItems'](null, {
      repoPath: '/workspace/repo',
      limit: 10,
      query: ''
    })

    expect(listWorkItemsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      10,
      '',
      undefined,
      undefined,
      'openclaw-2',
      undefined
    )
  })

  it('threads SSH connectionId through pull request merge', async () => {
    harness.repos[0].connectionId = 'openclaw-2'
    mergePRMock.mockResolvedValue({ ok: true })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:mergePR'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        method: 'squash',
        prRepo: { owner: 'acme', repo: 'orca' }
      }
    )

    expect(mergePRMock).toHaveBeenCalledWith('/workspace/repo', 42, 'squash', 'openclaw-2', {
      owner: 'acme',
      repo: 'orca'
    })
  })

  it('threads SSH connectionId through pull request auto-merge', async () => {
    harness.repos[0].connectionId = 'openclaw-2'
    setPRAutoMergeMock.mockResolvedValue({ ok: true })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:setPRAutoMerge'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        enabled: true,
        method: 'squash',
        prRepo: { owner: 'acme', repo: 'orca' }
      }
    )

    expect(setPRAutoMergeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      true,
      'squash',
      'openclaw-2',
      {
        owner: 'acme',
        repo: 'orca'
      }
    )
  })
})
