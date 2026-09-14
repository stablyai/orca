import { type Mock, vi } from 'vitest'

// Mocked module shapes for the GitHub IPC route tests. Built inside `vi.hoisted`
// so each test file's own `vi.mock` factories can hand the objects back verbatim.

const CLIENT_EXPORTS = [
  'getPRForBranch',
  'getIssue',
  'getWorkItem',
  'getWorkItemByOwnerRepo',
  'listIssues',
  'listWorkItems',
  'countWorkItems',
  'createIssue',
  'updateIssue',
  'addIssueComment',
  'listLabels',
  'listAssignableUsers',
  'getAuthenticatedViewer',
  'getPRChecks',
  'getPRCheckDetails',
  'getPRComments',
  'setPRCommentReaction',
  'resolveReviewThread',
  'setPRFileViewed',
  'addPRReviewComment',
  'addPRReviewCommentReply',
  'updatePRTitle',
  'mergePR',
  'setPRAutoMerge',
  'updatePRState',
  'markPRReadyForReview',
  'rerunPRChecks',
  'requestPRReviewers',
  'removePRReviewers',
  'checkOrcaStarred',
  'starOrca'
] as const

const WORK_ITEM_DETAILS_EXPORTS = ['getWorkItemDetails', 'getPRFileContents'] as const

const PR_REFRESH_EXPORTS = [
  'clearVisiblePRRefreshWindow',
  'enqueuePRRefresh',
  'refreshPRNow',
  'reportVisiblePRRefreshCandidates',
  'setPRRefreshOutcomeObserver'
] as const

type MockedModule<Names extends readonly string[]> = Record<Names[number], Mock>

function mockedModule<Names extends readonly string[]>(names: Names): MockedModule<Names> {
  return Object.fromEntries(names.map((name) => [name, vi.fn()])) as MockedModule<Names>
}

export type GitHubIpcMocks = {
  electron: {
    ipcMain: { handle: Mock }
    webContents: { getAllWebContents: Mock }
  }
  client: MockedModule<typeof CLIENT_EXPORTS>
  workItemDetails: MockedModule<typeof WORK_ITEM_DETAILS_EXPORTS>
  prRefresh: MockedModule<typeof PR_REFRESH_EXPORTS>
  telemetry: { track: Mock }
  cohort: { getCohortAtEmit: Mock }
  ui: { sendToTrustedUIRenderer: Mock }
}

export function createGitHubIpcMocks(): GitHubIpcMocks {
  return {
    electron: {
      ipcMain: { handle: vi.fn() },
      webContents: { getAllWebContents: vi.fn() }
    },
    client: mockedModule(CLIENT_EXPORTS),
    workItemDetails: mockedModule(WORK_ITEM_DETAILS_EXPORTS),
    prRefresh: mockedModule(PR_REFRESH_EXPORTS),
    telemetry: { track: vi.fn() },
    cohort: { getCohortAtEmit: vi.fn() },
    ui: { sendToTrustedUIRenderer: vi.fn() }
  }
}

export function listGitHubIpcMockFns(mocks: GitHubIpcMocks): Mock[] {
  return [
    mocks.electron.ipcMain.handle,
    mocks.electron.webContents.getAllWebContents,
    ...Object.values<Mock>(mocks.client),
    ...Object.values<Mock>(mocks.workItemDetails),
    ...Object.values<Mock>(mocks.prRefresh),
    mocks.telemetry.track,
    mocks.cohort.getCohortAtEmit,
    mocks.ui.sendToTrustedUIRenderer
  ]
}
