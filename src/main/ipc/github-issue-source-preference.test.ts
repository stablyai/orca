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

  it('forwards listIssues for registered repositories and unwraps items', async () => {
    listIssuesMock.mockResolvedValue({ items: [] })

    registerGitHubHandlers(store as never, stats as never)

    const result = await handlers['gh:listIssues'](null, {
      repoPath: '/workspace/repo',
      limit: 5
    })

    expect(listIssuesMock).toHaveBeenCalledWith('/workspace/repo', 5, undefined, null)
    expect(result).toEqual([])
  })

  it('drops the error field from listIssues envelope at the IPC boundary', async () => {
    // Why: src/main/ipc/github.ts intentionally unwraps the { items, error? }
    // envelope to just `items` to preserve the pre-feature-1
    // `Promise<IssueInfo[]>` contract for `gh:listIssues`. Feature 1's UI
    // consumes the richer envelope through `gh:listWorkItems` instead. This
    // test locks in that intentional drop so a future change that starts
    // propagating the error through this channel (or that throws when an
    // error is present) is caught.
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
    // Why: repo.issueSourcePreference must reach listIssues so the upstream
    // repo is queried when configured. A regression that drops the arg would
    // pass the default-fixture tests (which assert `undefined`) silently, so
    // this test pins the non-undefined preference-threading contract.
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
    // Why: gh:listWorkItems must also forward repo.issueSourcePreference
    // (5th arg) so the work-items view honors the per-repo source selector.
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

  // Why: open-by-number must pin the same source the list uses, else a fork and
  // its upstream sharing PR #42 open different PRs from the same click.
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
})
