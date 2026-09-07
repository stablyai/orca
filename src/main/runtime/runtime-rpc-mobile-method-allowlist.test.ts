import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { remoteRpcContentBudget } from '../../shared/remote-rpc-content-budget'
import { DeviceRegistry } from './device-registry'
import { createMobileRpcSurfaceRuntime } from './runtime-rpc-mobile-method-allowlist-fixtures'

describe('OrcaRuntimeRpcServer', () => {
  it('limits mobile-scoped WebSocket tokens to the mobile RPC surface', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const { runtime, mocks, expectedCodexResetScope } = createMobileRpcSurfaceRuntime()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const mobile = server['deviceRegistry']!.addDevice('phone', 'mobile')
    const replies: Record<string, unknown>[] = []
    const dispatch = async (request: Record<string, unknown>): Promise<void> => {
      await server['handleWebSocketMessage'](
        JSON.stringify(request),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {}
      )
    }

    await dispatch({
      id: 'req_forbidden',
      // files.delete is a real registered RPC intentionally kept off the
      // mobile allowlist — mobile clients must never delete host files.
      method: 'files.delete',
      deviceToken: mobile.token,
      params: { worktree: 'id:wt-1' }
    })
    await dispatch({
      id: 'req_allowed',
      method: 'status.get',
      deviceToken: mobile.token
    })
    await dispatch({
      id: 'req_settings_get',
      method: 'settings.get',
      deviceToken: mobile.token
    })
    await dispatch({
      id: 'req_settings_update',
      method: 'settings.update',
      deviceToken: mobile.token,
      params: { defaultTaskSource: 'linear' }
    })
    await dispatch({
      id: 'req_github_projects',
      method: 'github.project.listAccessible',
      deviceToken: mobile.token,
      params: {}
    })
    await dispatch({
      id: 'req_project_issue_types',
      method: 'github.project.listIssueTypesBySlug',
      deviceToken: mobile.token,
      params: { owner: 'stablyai', repo: 'orca' }
    })
    await dispatch({
      id: 'req_project_labels',
      method: 'github.project.listLabelsBySlug',
      deviceToken: mobile.token,
      params: { owner: 'stablyai', repo: 'orca' }
    })
    await dispatch({
      id: 'req_project_assignees',
      method: 'github.project.listAssignableUsersBySlug',
      deviceToken: mobile.token,
      params: { owner: 'stablyai', repo: 'orca', seedLogins: ['alex'] }
    })
    await dispatch({
      id: 'req_project_update_issue',
      method: 'github.project.updateIssueBySlug',
      deviceToken: mobile.token,
      params: {
        owner: 'stablyai',
        repo: 'orca',
        number: 123,
        updates: { title: 'New title' }
      }
    })
    await dispatch({
      id: 'req_project_update_issue_type',
      method: 'github.project.updateIssueTypeBySlug',
      deviceToken: mobile.token,
      params: {
        owner: 'stablyai',
        repo: 'orca',
        number: 123,
        issueTypeId: 'type-1'
      }
    })
    await dispatch({
      id: 'req_project_update_field',
      method: 'github.project.updateItemField',
      deviceToken: mobile.token,
      params: {
        projectId: 'project-1',
        itemId: 'item-1',
        fieldId: 'field-1',
        value: { kind: 'text', text: 'Ready' }
      }
    })
    await dispatch({
      id: 'req_project_clear_field',
      method: 'github.project.clearItemField',
      deviceToken: mobile.token,
      params: {
        projectId: 'project-1',
        itemId: 'item-1',
        fieldId: 'field-1'
      }
    })
    await dispatch({
      id: 'req_project_update_pr',
      method: 'github.project.updatePullRequestBySlug',
      deviceToken: mobile.token,
      params: {
        owner: 'stablyai',
        repo: 'orca',
        number: 456,
        updates: { state: 'closed' }
      }
    })
    await dispatch({
      id: 'req_project_add_comment',
      method: 'github.project.addIssueCommentBySlug',
      deviceToken: mobile.token,
      params: {
        owner: 'stablyai',
        repo: 'orca',
        number: 123,
        body: 'done'
      }
    })
    await dispatch({
      id: 'req_project_update_comment',
      method: 'github.project.updateIssueCommentBySlug',
      deviceToken: mobile.token,
      params: {
        owner: 'stablyai',
        repo: 'orca',
        commentId: 101,
        body: 'edited'
      }
    })
    await dispatch({
      id: 'req_project_delete_comment',
      method: 'github.project.deleteIssueCommentBySlug',
      deviceToken: mobile.token,
      params: {
        owner: 'stablyai',
        repo: 'orca',
        commentId: 101
      }
    })
    await dispatch({
      id: 'req_github_update_issue',
      method: 'github.updateIssue',
      deviceToken: mobile.token,
      params: {
        repo: 'id:repo-1',
        number: 123,
        updates: { title: 'New title', addLabels: ['bug'] }
      }
    })
    await dispatch({
      id: 'req_github_labels',
      method: 'github.listLabels',
      deviceToken: mobile.token,
      params: { repo: 'id:repo-1' }
    })
    await dispatch({
      id: 'req_github_assignees',
      method: 'github.listAssignableUsers',
      deviceToken: mobile.token,
      params: { repo: 'id:repo-1' }
    })
    await dispatch({
      id: 'req_github_add_comment',
      method: 'github.addIssueComment',
      deviceToken: mobile.token,
      params: {
        repo: 'id:repo-1',
        number: 123,
        body: 'done'
      }
    })
    await dispatch({
      id: 'req_github_add_review_comment',
      method: 'github.addPRReviewComment',
      deviceToken: mobile.token,
      params: {
        repo: 'id:repo-1',
        prNumber: 456,
        commitId: 'abc123',
        path: 'src/app.ts',
        line: 10,
        body: 'please fix'
      }
    })
    await dispatch({
      id: 'req_github_reply_review_comment',
      method: 'github.addPRReviewCommentReply',
      deviceToken: mobile.token,
      params: {
        repo: 'id:repo-1',
        prNumber: 456,
        commentId: 99,
        body: 'fixed',
        threadId: 'thread-1',
        path: 'src/app.ts',
        line: 10
      }
    })
    await dispatch({
      id: 'req_github_pr_file_contents',
      method: 'github.prFileContents',
      deviceToken: mobile.token,
      params: {
        repo: 'id:repo-1',
        prNumber: 456,
        path: 'src/app.ts',
        status: 'modified',
        headSha: 'abc123',
        baseSha: 'def456'
      }
    })
    await dispatch({
      id: 'req_github_rerun_checks',
      method: 'github.rerunPRChecks',
      deviceToken: mobile.token,
      params: {
        repo: 'id:repo-1',
        prNumber: 456,
        headSha: 'abc123',
        failedOnly: true
      }
    })
    await dispatch({
      id: 'req_github_resolve_thread',
      method: 'github.resolveReviewThread',
      deviceToken: mobile.token,
      params: {
        repo: 'id:repo-1',
        threadId: 'thread-1',
        resolve: true
      }
    })
    await dispatch({
      id: 'req_github_file_viewed',
      method: 'github.setPRFileViewed',
      deviceToken: mobile.token,
      params: {
        repo: 'id:repo-1',
        pullRequestId: 'PR_kw',
        path: 'src/app.ts',
        viewed: true
      }
    })
    await dispatch({
      id: 'req_github_request_reviewers',
      method: 'github.requestPRReviewers',
      deviceToken: mobile.token,
      params: {
        repo: 'id:repo-1',
        prNumber: 456,
        reviewers: ['alex']
      }
    })
    await dispatch({
      id: 'req_github_merge_pr',
      method: 'github.mergePR',
      deviceToken: mobile.token,
      params: {
        repo: 'id:repo-1',
        prNumber: 456,
        method: 'squash'
      }
    })
    await dispatch({
      id: 'req_gitlab_add_issue_comment',
      method: 'gitlab.addIssueComment',
      deviceToken: mobile.token,
      params: {
        repo: 'id:repo-1',
        number: 123,
        body: 'done'
      }
    })
    await dispatch({
      id: 'req_gitlab_add_mr_comment',
      method: 'gitlab.addMRComment',
      deviceToken: mobile.token,
      params: {
        repo: 'id:repo-1',
        iid: 456,
        body: 'ship it'
      }
    })
    await dispatch({
      id: 'req_gitlab_resolve_mr_discussion',
      method: 'gitlab.resolveMRDiscussion',
      deviceToken: mobile.token,
      params: {
        repo: 'id:repo-1',
        iid: 456,
        discussionId: 'discussion-1',
        resolved: true
      }
    })
    await dispatch({
      id: 'req_gitlab_merge_mr',
      method: 'gitlab.mergeMR',
      deviceToken: mobile.token,
      params: {
        repo: 'id:repo-1',
        iid: 456,
        method: 'merge'
      }
    })
    await dispatch({
      id: 'req_linear_search',
      method: 'linear.searchIssues',
      deviceToken: mobile.token,
      params: { query: 'auth', limit: 10, workspaceId: 'workspace-1' }
    })
    await dispatch({
      id: 'req_linear_select_workspace',
      method: 'linear.selectWorkspace',
      deviceToken: mobile.token,
      params: { workspaceId: 'workspace-1' }
    })
    await dispatch({
      id: 'req_linear_team_labels',
      method: 'linear.teamLabels',
      deviceToken: mobile.token,
      params: { teamId: 'team-1', workspaceId: 'workspace-1' }
    })
    await dispatch({
      id: 'req_linear_team_members',
      method: 'linear.teamMembers',
      deviceToken: mobile.token,
      params: { teamId: 'team-1', workspaceId: 'workspace-1' }
    })
    await dispatch({
      id: 'req_linear_add_comment',
      method: 'linear.addIssueComment',
      deviceToken: mobile.token,
      params: { issueId: 'issue-1', workspaceId: 'workspace-1', body: 'done' }
    })
    await dispatch({
      id: 'req_git_status',
      method: 'git.status',
      deviceToken: mobile.token,
      params: { worktree: 'id:wt-1' }
    })
    await dispatch({
      id: 'req_git_push',
      method: 'git.push',
      deviceToken: mobile.token,
      params: { worktree: 'id:wt-1', publish: true }
    })
    await dispatch({
      id: 'req_git_upstream',
      method: 'git.upstreamStatus',
      deviceToken: mobile.token,
      params: { worktree: 'id:wt-1' }
    })
    await dispatch({
      id: 'req_git_rebase_from_base',
      method: 'git.rebaseFromBase',
      deviceToken: mobile.token,
      params: { worktree: 'id:wt-1', baseRef: 'origin/main' }
    })
    await dispatch({
      id: 'req_git_bulk_stage',
      method: 'git.bulkStage',
      deviceToken: mobile.token,
      params: { worktree: 'id:wt-1', filePaths: ['a.ts', 'b.ts'] }
    })
    await dispatch({
      id: 'req_git_abort_merge',
      method: 'git.abortMerge',
      deviceToken: mobile.token,
      params: { worktree: 'id:wt-1' }
    })
    await dispatch({
      id: 'req_git_abort_rebase',
      method: 'git.abortRebase',
      deviceToken: mobile.token,
      params: { worktree: 'id:wt-1' }
    })
    await dispatch({
      id: 'req_git_bulk_unstage',
      method: 'git.bulkUnstage',
      deviceToken: mobile.token,
      params: { worktree: 'id:wt-1', filePaths: ['c.ts'] }
    })
    await dispatch({
      id: 'req_select_claude',
      method: 'accounts.selectClaude',
      deviceToken: mobile.token,
      params: { accountId: 'claude-account' }
    })
    await dispatch({
      id: 'req_select_codex',
      method: 'accounts.selectCodex',
      deviceToken: mobile.token,
      params: { accountId: null }
    })
    await dispatch({
      id: 'req_consume_codex_reset',
      method: 'accounts.consumeCodexResetCredit',
      deviceToken: mobile.token,
      params: {
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        expectedScope: expectedCodexResetScope
      }
    })
    await dispatch({
      id: 'req_remove_claude',
      method: 'accounts.removeClaude',
      deviceToken: mobile.token,
      params: { accountId: 'claude-account' }
    })
    await dispatch({
      id: 'req_terminal_read',
      method: 'terminal.read',
      deviceToken: mobile.token,
      params: { terminal: 'term-1' }
    })
    await dispatch({
      id: 'req_files_open_diff',
      method: 'files.openDiff',
      deviceToken: mobile.token,
      params: { worktree: 'id:wt-1', relativePath: 'docs/readme.md', staged: true }
    })
    await dispatch({
      id: 'req_git_diff',
      method: 'git.diff',
      deviceToken: mobile.token,
      params: { worktree: 'id:wt-1', filePath: 'docs/readme.md', staged: false }
    })
    await dispatch({
      id: 'req_browser_tab_create',
      method: 'browser.tabCreate',
      deviceToken: mobile.token,
      params: { worktree: 'id:wt-1', url: 'about:blank' }
    })
    await dispatch({
      id: 'req_browser_viewport',
      method: 'browser.viewport',
      deviceToken: mobile.token,
      params: { worktree: 'id:wt-1', page: 'page-1', width: 390, height: 844 }
    })
    await dispatch({
      id: 'req_browser_certificate_proceed',
      method: 'browser.certificate.proceed',
      deviceToken: mobile.token,
      params: {
        worktree: 'id:wt-1',
        page: 'page-1',
        challengeId: 'challenge-1'
      }
    })
    await dispatch({
      id: 'req_browser_dialog_accept',
      method: 'browser.dialogAccept',
      deviceToken: mobile.token,
      params: { worktree: 'id:wt-1', page: 'page-1', text: 'ok' }
    })
    await dispatch({
      id: 'req_browser_dialog_dismiss',
      method: 'browser.dialogDismiss',
      deviceToken: mobile.token,
      params: { worktree: 'id:wt-1', page: 'page-1' }
    })
    expect(replies).toContainEqual(
      expect.objectContaining({
        id: 'req_forbidden',
        ok: false,
        error: expect.objectContaining({ code: 'forbidden' })
      })
    )
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_allowed', ok: true }))
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_settings_get', ok: true }))
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_settings_update', ok: true }))
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_github_projects', ok: true }))
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_project_issue_types', ok: true })
    )
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_project_labels', ok: true }))
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_project_assignees', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_project_update_issue', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_project_update_issue_type', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_project_update_field', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_project_clear_field', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_project_update_pr', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_project_add_comment', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_project_update_comment', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_project_delete_comment', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_github_update_issue', ok: true })
    )
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_github_labels', ok: true }))
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_github_assignees', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_github_add_comment', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_github_add_review_comment', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_github_reply_review_comment', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_github_pr_file_contents', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_github_rerun_checks', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_github_resolve_thread', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_github_file_viewed', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_github_request_reviewers', ok: true })
    )
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_github_merge_pr', ok: true }))
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_gitlab_add_issue_comment', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_gitlab_add_mr_comment', ok: true })
    )
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_gitlab_merge_mr', ok: true }))
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_linear_search', ok: true }))
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_linear_select_workspace', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_linear_team_labels', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_linear_team_members', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_linear_add_comment', ok: true })
    )
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_git_status', ok: true }))
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_git_push', ok: true }))
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_git_upstream', ok: true }))
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_git_rebase_from_base', ok: true })
    )
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_git_bulk_stage', ok: true }))
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_git_abort_merge', ok: true }))
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_git_abort_rebase', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_git_bulk_unstage', ok: true })
    )
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_select_claude', ok: true }))
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_select_codex', ok: true }))
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_consume_codex_reset', ok: true })
    )
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_terminal_read', ok: true }))
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_files_open_diff', ok: true }))
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_git_diff', ok: true }))
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_browser_tab_create', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_browser_viewport', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({
        id: 'req_browser_certificate_proceed',
        ok: false,
        error: expect.objectContaining({ code: 'forbidden' })
      })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_browser_dialog_accept', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_browser_dialog_dismiss', ok: true })
    )
    expect(replies).toContainEqual(
      expect.objectContaining({
        id: 'req_remove_claude',
        ok: false,
        error: expect.objectContaining({ code: 'forbidden' })
      })
    )
    expect(mocks.selectClaudeAccount).toHaveBeenCalledWith('claude-account')
    expect(mocks.selectCodexAccount).toHaveBeenCalledWith(null)
    expect(mocks.consumeCodexRateLimitResetCredit).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expectedCodexResetScope
    )
    expect(mocks.readTerminal).toHaveBeenCalledWith('term-1', { cursor: undefined })
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledWith('id:wt-1', { admissionTier: 'status' })
    expect(mocks.pushRuntimeGit).toHaveBeenCalledWith('id:wt-1', true, undefined, undefined)
    expect(mocks.getRuntimeGitUpstreamStatus).toHaveBeenCalledWith('id:wt-1')
    expect(mocks.bulkStageRuntimeGitPaths).toHaveBeenCalledWith('id:wt-1', ['a.ts', 'b.ts'])
    expect(mocks.abortRuntimeGitMerge).toHaveBeenCalledWith('id:wt-1')
    expect(mocks.abortRuntimeGitRebase).toHaveBeenCalledWith('id:wt-1')
    expect(mocks.bulkUnstageRuntimeGitPaths).toHaveBeenCalledWith('id:wt-1', ['c.ts'])
    expect(mocks.openMobileDiff).toHaveBeenCalledWith('id:wt-1', 'docs/readme.md', true)
    // A mobile WebSocket client is transport-capped; a local caller gets undefined here.
    expect(mocks.getRuntimeGitDiff).toHaveBeenCalledWith(
      'id:wt-1',
      'docs/readme.md',
      false,
      undefined,
      remoteRpcContentBudget('req_git_diff')
    )
    expect(mocks.browserTabCreate).toHaveBeenCalledWith(
      { worktree: 'id:wt-1', url: 'about:blank' },
      { pairedDeviceId: mobile.deviceId, clientKind: 'mobile' }
    )
    expect(mocks.browserSetViewport).toHaveBeenCalledWith({
      worktree: 'id:wt-1',
      page: 'page-1',
      width: 390,
      height: 844
    })
    expect(mocks.browserDialogAccept).toHaveBeenCalledWith({
      worktree: 'id:wt-1',
      page: 'page-1',
      text: 'ok'
    })
    expect(mocks.browserDialogDismiss).toHaveBeenCalledWith({
      worktree: 'id:wt-1',
      page: 'page-1'
    })
    expect(mocks.listGitHubIssueTypesBySlug).toHaveBeenCalledWith({
      owner: 'stablyai',
      repo: 'orca'
    })
    expect(mocks.listGitHubLabelsBySlug).toHaveBeenCalledWith({
      owner: 'stablyai',
      repo: 'orca'
    })
    expect(mocks.listGitHubAssignableUsersBySlug).toHaveBeenCalledWith({
      owner: 'stablyai',
      repo: 'orca',
      seedLogins: ['alex']
    })
    expect(mocks.updateGitHubIssueBySlug).toHaveBeenCalledWith({
      owner: 'stablyai',
      repo: 'orca',
      number: 123,
      updates: { title: 'New title' }
    })
    expect(mocks.updateGitHubIssueTypeBySlug).toHaveBeenCalledWith({
      owner: 'stablyai',
      repo: 'orca',
      number: 123,
      issueTypeId: 'type-1'
    })
    expect(mocks.updateGitHubPullRequestBySlug).toHaveBeenCalledWith({
      owner: 'stablyai',
      repo: 'orca',
      number: 456,
      updates: { state: 'closed' }
    })
    expect(mocks.addGitHubIssueCommentBySlug).toHaveBeenCalledWith({
      owner: 'stablyai',
      repo: 'orca',
      number: 123,
      body: 'done'
    })
    expect(mocks.updateGitHubIssueCommentBySlug).toHaveBeenCalledWith({
      owner: 'stablyai',
      repo: 'orca',
      commentId: 101,
      body: 'edited'
    })
    expect(mocks.deleteGitHubIssueCommentBySlug).toHaveBeenCalledWith({
      owner: 'stablyai',
      repo: 'orca',
      commentId: 101
    })
    expect(mocks.updateRepoIssue).toHaveBeenCalledWith('id:repo-1', 123, {
      title: 'New title',
      addLabels: ['bug']
    })
    expect(mocks.listRepoLabels).toHaveBeenCalledWith('id:repo-1')
    expect(mocks.listRepoAssignableUsers).toHaveBeenCalledWith('id:repo-1')
    expect(mocks.addRepoIssueComment).toHaveBeenCalledWith('id:repo-1', 123, 'done', null)
    expect(mocks.addRepoPRReviewComment).toHaveBeenCalledWith('id:repo-1', {
      prNumber: 456,
      commitId: 'abc123',
      path: 'src/app.ts',
      line: 10,
      startLine: undefined,
      body: 'please fix',
      prRepo: null
    })
    expect(mocks.addRepoPRReviewCommentReply).toHaveBeenCalledWith('id:repo-1', {
      prNumber: 456,
      commentId: 99,
      body: 'fixed',
      threadId: 'thread-1',
      path: 'src/app.ts',
      line: 10,
      prRepo: null
    })
    expect(mocks.getRepoPRFileContents).toHaveBeenCalledWith('id:repo-1', {
      prNumber: 456,
      path: 'src/app.ts',
      oldPath: undefined,
      status: 'modified',
      headSha: 'abc123',
      baseSha: 'def456',
      prRepo: null
    })
    expect(mocks.rerunRepoPRChecks).toHaveBeenCalledWith('id:repo-1', 456, {
      headSha: 'abc123',
      failedOnly: true,
      prRepo: null
    })
    expect(mocks.resolveRepoReviewThread).toHaveBeenCalledWith('id:repo-1', 'thread-1', true, null)
    expect(mocks.setRepoPRFileViewed).toHaveBeenCalledWith('id:repo-1', {
      pullRequestId: 'PR_kw',
      path: 'src/app.ts',
      viewed: true,
      prRepo: null
    })
    expect(mocks.requestRepoPRReviewers).toHaveBeenCalledWith('id:repo-1', 456, ['alex'], null)
    expect(mocks.mergeRepoPR).toHaveBeenCalledWith('id:repo-1', 456, 'squash', null)
    expect(mocks.addGitLabRepoIssueComment).toHaveBeenCalledWith(
      'id:repo-1',
      123,
      'done',
      undefined
    )
    expect(mocks.addGitLabRepoMRComment).toHaveBeenCalledWith(
      'id:repo-1',
      456,
      'ship it',
      undefined
    )
    expect(mocks.resolveGitLabRepoMRDiscussion).toHaveBeenCalledWith(
      'id:repo-1',
      456,
      'discussion-1',
      true,
      undefined
    )
    expect(mocks.mergeGitLabRepoMR).toHaveBeenCalledWith('id:repo-1', 456, 'merge', undefined)
    expect(mocks.updateGitHubProjectItemField).toHaveBeenCalledWith({
      projectId: 'project-1',
      itemId: 'item-1',
      fieldId: 'field-1',
      value: { kind: 'text', text: 'Ready' }
    })
    expect(mocks.clearGitHubProjectItemField).toHaveBeenCalledWith({
      projectId: 'project-1',
      itemId: 'item-1',
      fieldId: 'field-1'
    })
    expect(mocks.linearSearchIssues).toHaveBeenCalledWith('auth', 10, 'workspace-1')
    expect(mocks.linearSelectWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(mocks.linearTeamLabels).toHaveBeenCalledWith('team-1', 'workspace-1')
    expect(mocks.linearTeamMembers).toHaveBeenCalledWith('team-1', 'workspace-1')
    expect(mocks.linearAddIssueComment).toHaveBeenCalledWith('issue-1', 'done', 'workspace-1')
    expect(mocks.removeClaudeAccount).not.toHaveBeenCalled()
  })
})
