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
  listIssues: listIssuesMock,
  listWorkItems: listWorkItemsMock,
  getWorkItem: getWorkItemMock
} = mocks.client
const { getWorkItemDetails: getWorkItemDetailsMock } = mocks.workItemDetails

describe('registerGitHubHandlers', () => {
  const harness = createGitHubIpcHarness(mocks)
  const { handlers, store, stats } = harness

  beforeEach(harness.reset)

  it('drops the error field from listIssues envelope at the IPC boundary', async () => {
    // Preserve legacy gh:listIssues arrays; only gh:listWorkItems exposes the richer items/error envelope.
    listIssuesMock.mockResolvedValue({
      items: [],
      error: {
        type: 'permission_denied',
        message:
          "You don't have permission to read issues for this repository. Check your GitHub token scopes."
      }
    })

    registerGitHubHandlers(store as never, stats as never)

    const result = await handlers['gh:listIssues'](null, {
      repoPath: '/workspace/repo',
      limit: 5
    })

    expect(listIssuesMock).toHaveBeenCalledWith('/workspace/repo', 5, undefined, null)
    expect(result).toEqual([])
  })

  it('threads issueSourcePreference through gh:listIssues', async () => {
    // Use a nondefault preference so missing argument forwarding cannot pass silently.
    harness.repos[0].issueSourcePreference = 'upstream'
    listIssuesMock.mockResolvedValue({ items: [] })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:listIssues'](null, {
      repoPath: '/workspace/repo',
      limit: 5
    })

    expect(listIssuesMock).toHaveBeenCalledWith('/workspace/repo', 5, 'upstream', null)
  })

  it('threads issueSourcePreference through gh:listWorkItems', async () => {
    harness.repos[0].issueSourcePreference = 'origin'
    listWorkItemsMock.mockResolvedValue({ items: [] })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:listWorkItems'](null, {
      repoPath: '/workspace/repo',
      limit: 10,
      query: 'is:open',
      page: 2,
      noCache: true
    })

    expect(listWorkItemsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      10,
      'is:open',
      2,
      'origin',
      null,
      true
    )
  })

  // Open-by-number must use the listed source when origin/upstream share an item number.
  it('pins the repo origin source preference on work item and details IPC', async () => {
    harness.repos = [
      {
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        issueSourcePreference: 'origin'
      }
    ]
    getWorkItemMock.mockResolvedValue(null)
    getWorkItemDetailsMock.mockResolvedValue(null)
    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:workItem'](null, { repoPath: '/workspace/repo', number: 42, type: 'pr' })
    await handlers['gh:workItemDetails'](null, {
      repoPath: '/workspace/repo',
      number: 42,
      type: 'pr'
    })

    expect(getWorkItemMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      'pr',
      null,
      undefined,
      'origin'
    )
    expect(getWorkItemDetailsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      'pr',
      null,
      undefined,
      'origin'
    )
  })

  it('passes the displayed repository ahead of the current source preference', async () => {
    harness.repos[0].issueSourcePreference = 'upstream'
    const ownerRepo = { owner: 'fork-owner', repo: 'widgets', host: 'github.com' }
    mocks.client.updateIssue.mockResolvedValue({ ok: false, error: 'stub' })
    getWorkItemDetailsMock.mockResolvedValue(null)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These fixtures implement the repo methods used by the handlers; unrelated handlers are only registered.
    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:workItemDetails'](null, {
      repoPath: '/workspace/repo',
      number: 12,
      type: 'issue',
      ownerRepo
    })
    await handlers['gh:updateIssue'](null, {
      repoPath: '/workspace/repo',
      number: 12,
      updates: { body: 'Origin edit' },
      ownerRepo
    })
    await handlers['gh:listLabels'](null, { repoPath: '/workspace/repo', ownerRepo })
    await handlers['gh:listAssignableUsers'](null, { repoPath: '/workspace/repo', ownerRepo })

    expect(getWorkItemDetailsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      12,
      'issue',
      null,
      undefined,
      'upstream',
      ownerRepo
    )
    expect(mocks.client.updateIssue).toHaveBeenCalledWith(
      '/workspace/repo',
      12,
      { body: 'Origin edit' },
      null,
      undefined,
      'upstream',
      ownerRepo
    )
    expect(mocks.client.listLabels).toHaveBeenCalledWith(
      '/workspace/repo',
      'upstream',
      null,
      undefined,
      ownerRepo
    )
    expect(mocks.client.listAssignableUsers).toHaveBeenCalledWith(
      '/workspace/repo',
      'upstream',
      null,
      undefined,
      ownerRepo
    )
  })

  it('pins the repo origin source preference on issue update and comment IPC', async () => {
    harness.repos = [
      {
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        issueSourcePreference: 'origin'
      }
    ]
    mocks.client.updateIssue.mockResolvedValue({ ok: false, error: 'stub' })
    mocks.client.addIssueComment.mockResolvedValue({ ok: false, error: 'stub' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These fixtures implement the repo methods used by the handlers; unrelated handlers are only registered.
    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:updateIssue'](null, {
      repoPath: '/workspace/repo',
      number: 5,
      updates: { body: 'Updated' }
    })
    await handlers['gh:addIssueComment'](null, {
      repoPath: '/workspace/repo',
      number: 5,
      body: 'Issue comment'
    })
    await handlers['gh:addIssueComment'](null, {
      repoPath: '/workspace/repo',
      number: 6,
      body: 'PR comment',
      type: 'pr'
    })

    expect(mocks.client.updateIssue).toHaveBeenCalledWith(
      '/workspace/repo',
      5,
      { body: 'Updated' },
      null,
      undefined,
      'origin'
    )
    expect(mocks.client.addIssueComment).toHaveBeenNthCalledWith(
      1,
      '/workspace/repo',
      5,
      'Issue comment',
      null,
      null,
      undefined,
      'origin'
    )
    expect(mocks.client.addIssueComment).toHaveBeenNthCalledWith(
      2,
      '/workspace/repo',
      6,
      'PR comment',
      null,
      null,
      undefined,
      undefined
    )
  })
})
