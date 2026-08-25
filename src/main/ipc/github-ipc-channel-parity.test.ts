import { readFileSync } from 'node:fs'
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

import * as github from './github'
import { createGitHubIpcHarness } from './github-ipc-test-harness'

const EXPECTED_GITHUB_IPC_CHANNELS = [
  'gh:prForBranch',
  'gh:refreshPRNow',
  'gh:enqueuePRRefresh',
  'gh:reportVisiblePRRefreshCandidates',
  'gh:issue',
  'gh:listIssues',
  'gh:createIssue',
  'gh:listWorkItems',
  'gh:countWorkItems',
  'gh:workItem',
  'gh:workItemByOwnerRepo',
  'gh:workItemDetails',
  'gh:notifyWorkItemMutated',
  'gh:prFileContents',
  'gh:repoSlug',
  'gh:repoUpstream',
  'gh:prChecks',
  'gh:prCheckDetails',
  'gh:prComments',
  'gh:setPRCommentReaction',
  'gh:resolveReviewThread',
  'gh:setPRFileViewed',
  'gh:addPRReviewCommentReply',
  'gh:addPRReviewComment',
  'gh:updatePRTitle',
  'gh:mergePR',
  'gh:setPRAutoMerge',
  'gh:updatePRState',
  'gh:rerunPRChecks',
  'gh:requestPRReviewers',
  'gh:removePRReviewers',
  'gh:updateIssue',
  'gh:addIssueComment',
  'gh:listLabels',
  'gh:listAssignableUsers',
  'gh:viewer',
  'gh:checkOrcaStarred',
  'gh:starOrca',
  'gh:rateLimit',
  'gh:diagnoseAuth',
  'gh:listAccessibleProjects',
  'gh:resolveProjectRef',
  'gh:listProjectViews',
  'gh:getProjectViewTable',
  'gh:projectWorkItemDetailsBySlug',
  'gh:updateProjectItemField',
  'gh:clearProjectItemField',
  'gh:updateIssueBySlug',
  'gh:updatePullRequestBySlug',
  'gh:addIssueCommentBySlug',
  'gh:updateIssueCommentBySlug',
  'gh:deleteIssueCommentBySlug',
  'gh:listLabelsBySlug',
  'gh:listAssignableUsersBySlug',
  'gh:listIssueTypesBySlug',
  'gh:updateIssueTypeBySlug'
] as const

describe('GitHub IPC channel parity', () => {
  const harness = createGitHubIpcHarness(mocks)

  beforeEach(harness.reset)

  it('preserves the facade and fixed IPC channel contract', () => {
    github.registerGitHubHandlers(harness.store as never, harness.stats as never)

    const preloadSource = readFileSync(new URL('../../preload/index.ts', import.meta.url), 'utf8')
    const exposedChannels = [...preloadSource.matchAll(/ipcRenderer\.invoke\('(gh:[^']+)'/g)].map(
      (match) => match[1]
    )
    const registeredChannels = mocks.electron.ipcMain.handle.mock.calls.map(
      ([channel]) => channel as string
    )

    expect(Object.keys(github)).toEqual(['registerGitHubHandlers'])
    expect(new Set(registeredChannels).size).toBe(registeredChannels.length)
    expect(registeredChannels).toEqual(EXPECTED_GITHUB_IPC_CHANNELS)
    expect(registeredChannels.toSorted()).toEqual([...new Set(exposedChannels)].toSorted())
  })
})
