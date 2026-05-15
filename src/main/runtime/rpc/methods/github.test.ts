/* eslint-disable max-lines -- Why: runtime GitHub RPC methods share one dispatcher suite so repo-scoped and Project-scoped contract coverage cannot drift. */
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { GITHUB_METHODS } from './github'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('github RPC methods', () => {
  it('resolves the repo slug on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRepoSlug: vi.fn().mockResolvedValue({ owner: 'acme', repo: 'orca' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(makeRequest('github.repoSlug', { repo: 'repo-1' }))

    expect(runtime.getRepoSlug).toHaveBeenCalledWith('repo-1')
    expect(response).toMatchObject({
      ok: true,
      result: { owner: 'acme', repo: 'orca' }
    })
  })

  it('fetches GitHub rate limits on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getGitHubRateLimit: vi.fn().mockResolvedValue({ ok: true, snapshot: { core: {} } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(makeRequest('github.rateLimit', { force: true }))

    expect(runtime.getGitHubRateLimit).toHaveBeenCalledWith({ force: true })
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('lists work items on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listRepoWorkItems: vi.fn().mockResolvedValue({ items: [] })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.listWorkItems', { repo: 'repo-1', limit: 10, query: 'is:pr' })
    )

    expect(runtime.listRepoWorkItems).toHaveBeenCalledWith('repo-1', 10, 'is:pr', undefined)
    expect(response).toMatchObject({ ok: true, result: { items: [] } })
  })

  it('looks up a single work item on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRepoWorkItem: vi.fn().mockResolvedValue({ number: 12, type: 'pr' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.workItem', { repo: 'repo-1', number: 12, type: 'pr' })
    )

    expect(runtime.getRepoWorkItem).toHaveBeenCalledWith('repo-1', 12, 'pr')
    expect(response).toMatchObject({ ok: true, result: { number: 12, type: 'pr' } })
  })

  it('looks up a single work item by explicit owner/repo on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRepoWorkItemByOwnerRepo: vi.fn().mockResolvedValue({ number: 12, type: 'pr' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.workItemByOwnerRepo', {
        repo: 'repo-1',
        owner: 'acme',
        ownerRepo: 'orca',
        number: 12,
        type: 'pr'
      })
    )

    expect(runtime.getRepoWorkItemByOwnerRepo).toHaveBeenCalledWith(
      'repo-1',
      { owner: 'acme', repo: 'orca' },
      12,
      'pr'
    )
    expect(response).toMatchObject({ ok: true, result: { number: 12, type: 'pr' } })
  })

  it('fetches work item details on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRepoWorkItemDetails: vi.fn().mockResolvedValue({ body: 'Details' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.workItemDetails', { repo: 'repo-1', number: 12, type: 'issue' })
    )

    expect(runtime.getRepoWorkItemDetails).toHaveBeenCalledWith('repo-1', 12, 'issue')
    expect(response).toMatchObject({ ok: true, result: { body: 'Details' } })
  })

  it('counts work items on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      countRepoWorkItems: vi.fn().mockResolvedValue(3)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.countWorkItems', { repo: 'repo-1', query: 'is:open' })
    )

    expect(runtime.countRepoWorkItems).toHaveBeenCalledWith('repo-1', 'is:open')
    expect(response).toMatchObject({ ok: true, result: 3 })
  })

  it('lists repo issue metadata on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listRepoLabels: vi.fn().mockResolvedValue(['bug']),
      listRepoAssignableUsers: vi.fn().mockResolvedValue([{ login: 'octo' }])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const labels = await dispatcher.dispatch(makeRequest('github.listLabels', { repo: 'repo-1' }))
    const users = await dispatcher.dispatch(
      makeRequest('github.listAssignableUsers', { repo: 'repo-1' })
    )

    expect(runtime.listRepoLabels).toHaveBeenCalledWith('repo-1')
    expect(runtime.listRepoAssignableUsers).toHaveBeenCalledWith('repo-1')
    expect(labels).toMatchObject({ ok: true, result: ['bug'] })
    expect(users).toMatchObject({ ok: true, result: [{ login: 'octo' }] })
  })

  it('fetches PR checks on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRepoPRChecks: vi.fn().mockResolvedValue([])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.prChecks', {
        repo: 'repo-1',
        prNumber: 7,
        headSha: 'abc123',
        noCache: true
      })
    )

    expect(runtime.getRepoPRChecks).toHaveBeenCalledWith('repo-1', 7, 'abc123', {
      noCache: true
    })
    expect(response).toMatchObject({ ok: true, result: [] })
  })

  it('fetches PR file contents on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRepoPRFileContents: vi.fn().mockResolvedValue({
        original: '',
        modified: 'new',
        originalIsBinary: false,
        modifiedIsBinary: false
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.prFileContents', {
        repo: 'repo-1',
        prNumber: 7,
        path: 'src/app.ts',
        status: 'modified',
        headSha: 'head',
        baseSha: 'base'
      })
    )

    expect(runtime.getRepoPRFileContents).toHaveBeenCalledWith('repo-1', {
      prNumber: 7,
      path: 'src/app.ts',
      oldPath: undefined,
      status: 'modified',
      headSha: 'head',
      baseSha: 'base'
    })
    expect(response).toMatchObject({ ok: true, result: { modified: 'new' } })
  })

  it('resolves review threads on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveRepoReviewThread: vi.fn().mockResolvedValue(true)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.resolveReviewThread', {
        repo: 'repo-1',
        threadId: 'PRRT_1',
        resolve: true
      })
    )

    expect(runtime.resolveRepoReviewThread).toHaveBeenCalledWith('repo-1', 'PRRT_1', true)
    expect(response).toMatchObject({ ok: true, result: true })
  })

  it('updates PR titles on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateRepoPRTitle: vi.fn().mockResolvedValue(true)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.updatePRTitle', {
        repo: 'repo-1',
        prNumber: 7,
        title: 'New title'
      })
    )

    expect(runtime.updateRepoPRTitle).toHaveBeenCalledWith('repo-1', 7, 'New title')
    expect(response).toMatchObject({ ok: true, result: true })
  })

  it('merges PRs on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      mergeRepoPR: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.mergePR', {
        repo: 'repo-1',
        prNumber: 7,
        method: 'squash'
      })
    )

    expect(runtime.mergeRepoPR).toHaveBeenCalledWith('repo-1', 7, 'squash')
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('creates issues on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createRepoIssue: vi.fn().mockResolvedValue({ ok: true, number: 3, url: 'https://gh/3' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.createIssue', {
        repo: 'repo-1',
        title: 'Bug',
        body: 'Body'
      })
    )

    expect(runtime.createRepoIssue).toHaveBeenCalledWith('repo-1', 'Bug', 'Body')
    expect(response).toMatchObject({ ok: true, result: { ok: true, number: 3 } })
  })

  it('updates issues on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateRepoIssue: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.updateIssue', {
        repo: 'repo-1',
        number: 3,
        updates: { state: 'closed', addLabels: ['bug'] }
      })
    )

    expect(runtime.updateRepoIssue).toHaveBeenCalledWith('repo-1', 3, {
      state: 'closed',
      addLabels: ['bug']
    })
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('adds issue comments on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      addRepoIssueComment: vi.fn().mockResolvedValue({ ok: true, comment: { id: 1 } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.addIssueComment', {
        repo: 'repo-1',
        number: 3,
        body: 'Looks good',
        type: 'pr'
      })
    )

    expect(runtime.addRepoIssueComment).toHaveBeenCalledWith('repo-1', 3, 'Looks good')
    expect(response).toMatchObject({ ok: true, result: { ok: true, comment: { id: 1 } } })
  })

  it('adds PR review comments on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      addRepoPRReviewComment: vi.fn().mockResolvedValue({ ok: true, comment: { id: 2 } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.addPRReviewComment', {
        repo: 'repo-1',
        prNumber: 7,
        commitId: 'head',
        path: 'src/app.ts',
        line: 12,
        startLine: 10,
        body: 'Please tweak'
      })
    )

    expect(runtime.addRepoPRReviewComment).toHaveBeenCalledWith('repo-1', {
      prNumber: 7,
      commitId: 'head',
      path: 'src/app.ts',
      line: 12,
      startLine: 10,
      body: 'Please tweak'
    })
    expect(response).toMatchObject({ ok: true, result: { ok: true, comment: { id: 2 } } })
  })

  it('adds PR review comment replies on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      addRepoPRReviewCommentReply: vi.fn().mockResolvedValue({ ok: true, comment: { id: 4 } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.addPRReviewCommentReply', {
        repo: 'repo-1',
        prNumber: 7,
        commentId: 2,
        body: 'Done',
        threadId: 'PRRT_1',
        path: 'src/app.ts',
        line: 12
      })
    )

    expect(runtime.addRepoPRReviewCommentReply).toHaveBeenCalledWith('repo-1', {
      prNumber: 7,
      commentId: 2,
      body: 'Done',
      threadId: 'PRRT_1',
      path: 'src/app.ts',
      line: 12
    })
    expect(response).toMatchObject({ ok: true, result: { ok: true, comment: { id: 4 } } })
  })

  it('fetches GitHub project views on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listGitHubProjectViews: vi.fn().mockResolvedValue({ ok: true, views: [] })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.project.listViews', {
        owner: 'acme',
        ownerType: 'organization',
        projectNumber: 1
      })
    )

    expect(runtime.listGitHubProjectViews).toHaveBeenCalledWith({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 1
    })
    expect(response).toMatchObject({ ok: true, result: { ok: true, views: [] } })
  })

  it('lists slug-addressed issue metadata on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listGitHubLabelsBySlug: vi.fn().mockResolvedValue({ ok: true, labels: ['bug'] }),
      listGitHubAssignableUsersBySlug: vi
        .fn()
        .mockResolvedValue({ ok: true, users: [{ login: 'octo' }] }),
      listGitHubIssueTypesBySlug: vi.fn().mockResolvedValue({ ok: true, types: [{ id: 'it-1' }] })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const labels = await dispatcher.dispatch(
      makeRequest('github.project.listLabelsBySlug', { owner: 'acme', repo: 'orca' })
    )
    const users = await dispatcher.dispatch(
      makeRequest('github.project.listAssignableUsersBySlug', {
        owner: 'acme',
        repo: 'orca',
        seedLogins: ['octo']
      })
    )
    const issueTypes = await dispatcher.dispatch(
      makeRequest('github.project.listIssueTypesBySlug', { owner: 'acme', repo: 'orca' })
    )

    expect(runtime.listGitHubLabelsBySlug).toHaveBeenCalledWith({ owner: 'acme', repo: 'orca' })
    expect(runtime.listGitHubAssignableUsersBySlug).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'orca',
      seedLogins: ['octo']
    })
    expect(runtime.listGitHubIssueTypesBySlug).toHaveBeenCalledWith({ owner: 'acme', repo: 'orca' })
    expect(labels).toMatchObject({ ok: true, result: { ok: true, labels: ['bug'] } })
    expect(users).toMatchObject({ ok: true, result: { ok: true, users: [{ login: 'octo' }] } })
    expect(issueTypes).toMatchObject({ ok: true, result: { ok: true, types: [{ id: 'it-1' }] } })
  })

  it('fetches GitHub project tables on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getGitHubProjectViewTable: vi.fn().mockResolvedValue({ ok: true, data: { rows: [] } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.project.viewTable', {
        owner: 'acme',
        ownerType: 'organization',
        projectNumber: 1,
        viewId: 'view-1',
        queryOverride: 'is:open'
      })
    )

    expect(runtime.getGitHubProjectViewTable).toHaveBeenCalledWith({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 1,
      viewId: 'view-1',
      viewNumber: undefined,
      viewName: undefined,
      queryOverride: 'is:open'
    })
    expect(response).toMatchObject({ ok: true, result: { ok: true, data: { rows: [] } } })
  })

  it('updates GitHub project item fields on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateGitHubProjectItemField: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.project.updateItemField', {
        projectId: 'project-1',
        itemId: 'item-1',
        fieldId: 'field-1',
        value: { kind: 'text', text: 'Now' }
      })
    )

    expect(runtime.updateGitHubProjectItemField).toHaveBeenCalledWith({
      projectId: 'project-1',
      itemId: 'item-1',
      fieldId: 'field-1',
      value: { kind: 'text', text: 'Now' }
    })
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('updates GitHub project issue types on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateGitHubIssueTypeBySlug: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.project.updateIssueTypeBySlug', {
        owner: 'acme',
        repo: 'orca',
        number: 9,
        issueTypeId: null
      })
    )

    expect(runtime.updateGitHubIssueTypeBySlug).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'orca',
      number: 9,
      issueTypeId: null
    })
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })
})
