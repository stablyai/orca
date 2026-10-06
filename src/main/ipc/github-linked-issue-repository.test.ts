import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createGitHubIpcMocks } = await import('./github-ipc-module-mocks')
  return createGitHubIpcMocks()
})
vi.mock('electron', () => mocks.electron)
vi.mock('../github/client', () => mocks.client)
vi.mock('../github/work-item-details', () => mocks.workItemDetails)

import { registerGitHubWorkItemHandlers } from './github-work-item-handlers'
import { createGitHubIpcHarness } from './github-ipc-test-harness'

describe('linked issue repository IPC', () => {
  const harness = createGitHubIpcHarness(mocks)
  beforeEach(() => {
    harness.reset()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness supplies every store method used by these handlers.
    registerGitHubWorkItemHandlers(harness.store as never)
  })

  it('passes the linked repository even when the selector points at upstream', async () => {
    harness.repos[0].issueSourcePreference = 'upstream'
    const ownerRepo = { owner: 'fork', repo: 'repo', host: 'github.com' }
    await harness.handlers['gh:issue'](null, {
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      number: 247,
      ownerRepo
    })
    expect(mocks.client.getIssue).toHaveBeenCalledWith('/workspace/repo', 247, null, {}, ownerRepo)
  })

  it('keeps the registered repository permission check', () => {
    expect(() =>
      harness.handlers['gh:issue'](null, {
        repoPath: '/unregistered',
        repoId: 'repo-1',
        number: 247,
        ownerRepo: { owner: 'fork', repo: 'repo', host: 'github.com' }
      })
    ).toThrow('repository path does not match repo id')
    expect(mocks.client.getIssue).not.toHaveBeenCalled()
  })
})
