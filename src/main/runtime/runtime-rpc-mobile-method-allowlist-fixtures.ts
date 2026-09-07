import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'

// Loose on purpose: the allowlist suite asserts call arguments, never RPC signatures.
export type MobileRpcMock = Mock<(...args: unknown[]) => unknown>

// Full mobile-surface runtime double: every RPC the mobile allowlist may reach.
export function createMobileRpcSurfaceRuntime() {
  const getStatus: MobileRpcMock = vi.fn().mockResolvedValue({ graphStatus: 'ok' })
  const pushRuntimeGit: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const selectClaudeAccount: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const selectCodexAccount: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const expectedCodexResetScope = {
    target: { runtime: 'host' as const, wslDistro: null },
    accountId: 'codex-account',
    accountRevision: 42,
    offerRevision: 'v1:offer'
  }
  const consumeCodexRateLimitResetCredit: MobileRpcMock = vi.fn().mockResolvedValue({
    outcome: 'reset',
    scope: expectedCodexResetScope,
    snapshot: { claude: null, codex: null }
  })
  const removeClaudeAccount: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const readTerminal: MobileRpcMock = vi.fn().mockResolvedValue({ tail: ['ok'] })
  const getRuntimeGitStatus: MobileRpcMock = vi
    .fn()
    .mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
  const getRuntimeGitUpstreamStatus: MobileRpcMock = vi
    .fn()
    .mockResolvedValue({ hasUpstream: true, ahead: 1, behind: 0 })
  const rebaseRuntimeGitFromBase: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const abortRuntimeGitMerge: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const abortRuntimeGitRebase: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const bulkStageRuntimeGitPaths: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const bulkUnstageRuntimeGitPaths: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const getRuntimeGitDiff: MobileRpcMock = vi.fn().mockResolvedValue({
    kind: 'text',
    originalContent: 'before\n',
    modifiedContent: 'after\n',
    originalIsBinary: false,
    modifiedIsBinary: false
  })
  const openMobileDiff: MobileRpcMock = vi.fn().mockResolvedValue({
    worktree: 'wt-1',
    relativePath: 'docs/readme.md',
    kind: 'markdown',
    opened: true
  })
  const browserTabCreate: MobileRpcMock = vi.fn().mockResolvedValue({ page: 'page-1' })
  const browserSetViewport: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const browserDialogAccept: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const browserDialogDismiss: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const listGitHubProjects: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true, projects: [] })
  const listGitHubLabelsBySlug: MobileRpcMock = vi
    .fn()
    .mockResolvedValue({ ok: true, labels: ['bug'] })
  const listGitHubAssignableUsersBySlug: MobileRpcMock = vi
    .fn()
    .mockResolvedValue({ ok: true, users: [{ login: 'alex' }] })
  const listGitHubIssueTypesBySlug: MobileRpcMock = vi.fn().mockResolvedValue({
    ok: true,
    types: [{ id: 'type-1', name: 'Bug', color: 'RED', description: null }]
  })
  const updateGitHubProjectItemField: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const clearGitHubProjectItemField: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const updateGitHubIssueBySlug: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const updateGitHubIssueTypeBySlug: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const updateGitHubPullRequestBySlug: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const updateRepoIssue: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const listRepoLabels: MobileRpcMock = vi.fn().mockResolvedValue(['bug'])
  const listRepoAssignableUsers: MobileRpcMock = vi.fn().mockResolvedValue([{ login: 'alex' }])
  const addRepoIssueComment: MobileRpcMock = vi
    .fn()
    .mockResolvedValue({ ok: true, comment: { id: 2 } })
  const addRepoPRReviewComment: MobileRpcMock = vi
    .fn()
    .mockResolvedValue({ ok: true, comment: { id: 3 } })
  const addRepoPRReviewCommentReply: MobileRpcMock = vi.fn().mockResolvedValue({
    ok: true,
    comment: { id: 4 }
  })
  const getRepoPRFileContents: MobileRpcMock = vi.fn().mockResolvedValue({
    original: 'before',
    modified: 'after',
    originalIsBinary: false,
    modifiedIsBinary: false
  })
  const rerunRepoPRChecks: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true, count: 1 })
  const resolveRepoReviewThread: MobileRpcMock = vi.fn().mockResolvedValue(true)
  const setRepoPRFileViewed: MobileRpcMock = vi.fn().mockResolvedValue(true)
  const requestRepoPRReviewers: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const mergeRepoPR: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const addGitLabRepoIssueComment: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const addGitLabRepoMRComment: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const resolveGitLabRepoMRDiscussion: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const mergeGitLabRepoMR: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const addGitHubIssueCommentBySlug: MobileRpcMock = vi.fn().mockResolvedValue({
    ok: true,
    comment: { id: 1, author: 'me', body: 'done', createdAt: '2026-01-01T00:00:00Z', url: '' }
  })
  const updateGitHubIssueCommentBySlug: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const deleteGitHubIssueCommentBySlug: MobileRpcMock = vi.fn().mockResolvedValue({ ok: true })
  const linearSearchIssues: MobileRpcMock = vi.fn().mockResolvedValue([])
  const linearSelectWorkspace: MobileRpcMock = vi.fn().mockReturnValue({
    connected: true,
    selectedWorkspaceId: 'workspace-1'
  })
  const linearTeamLabels: MobileRpcMock = vi
    .fn()
    .mockResolvedValue([{ id: 'label-1', name: 'bug' }])
  const linearTeamMembers: MobileRpcMock = vi
    .fn()
    .mockResolvedValue([{ id: 'member-1', displayName: 'Alex' }])
  const linearAddIssueComment: MobileRpcMock = vi
    .fn()
    .mockResolvedValue({ ok: true, id: 'comment-1' })
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getStatus,
    pushRuntimeGit,
    selectClaudeAccount,
    selectCodexAccount,
    consumeCodexRateLimitResetCredit,
    removeClaudeAccount,
    readTerminal,
    getRuntimeGitStatus,
    getRuntimeGitUpstreamStatus,
    rebaseRuntimeGitFromBase,
    abortRuntimeGitMerge,
    abortRuntimeGitRebase,
    bulkStageRuntimeGitPaths,
    bulkUnstageRuntimeGitPaths,
    getRuntimeGitDiff,
    openMobileDiff,
    browserTabCreate,
    browserSetViewport,
    browserDialogAccept,
    browserDialogDismiss,
    listGitHubProjects,
    listGitHubLabelsBySlug,
    listGitHubAssignableUsersBySlug,
    listGitHubIssueTypesBySlug,
    updateGitHubProjectItemField,
    clearGitHubProjectItemField,
    updateGitHubIssueBySlug,
    updateGitHubIssueTypeBySlug,
    updateGitHubPullRequestBySlug,
    updateRepoIssue,
    listRepoLabels,
    listRepoAssignableUsers,
    addRepoIssueComment,
    addRepoPRReviewComment,
    addRepoPRReviewCommentReply,
    getRepoPRFileContents,
    rerunRepoPRChecks,
    resolveRepoReviewThread,
    setRepoPRFileViewed,
    requestRepoPRReviewers,
    mergeRepoPR,
    addGitLabRepoIssueComment,
    addGitLabRepoMRComment,
    resolveGitLabRepoMRDiscussion,
    mergeGitLabRepoMR,
    addGitHubIssueCommentBySlug,
    updateGitHubIssueCommentBySlug,
    deleteGitHubIssueCommentBySlug,
    linearSearchIssues,
    linearSelectWorkspace,
    linearTeamLabels,
    linearTeamMembers,
    linearAddIssueComment,
    getClientSettings: vi.fn(() => ({ defaultTuiAgent: 'codex', agentCmdOverrides: {} })),
    updateClientSettings: vi.fn(() => ({ defaultTaskSource: 'linear' }))
  }
  return {
    runtime: runtime as unknown as OrcaRuntimeService,
    mocks: runtime,
    expectedCodexResetScope
  }
}
