import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { setConfiguredGitLabUrl } from '../../../gitlab/gitlab-known-host-probe'
import { GITLAB_METHODS } from './gitlab'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('gitlab RPC methods', () => {
  beforeEach(() => {
    setConfiguredGitLabUrl('https://gitlab.example.com')
  })

  afterEach(() => {
    setConfiguredGitLabUrl('')
  })

  it('routes GitLab task queries and mutations to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      diagnoseGitLabAuth: vi.fn().mockResolvedValue({ glabAvailable: true }),
      getGitLabRateLimit: vi.fn().mockResolvedValue({ ok: true }),
      listGitLabRepoMRs: vi.fn().mockResolvedValue({ items: [] }),
      listGitLabRepoWorkItems: vi.fn().mockResolvedValue({ items: [] }),
      listGitLabRepoIssues: vi.fn().mockResolvedValue({ items: [] }),
      listGitLabRepoTodos: vi.fn().mockResolvedValue([{ id: 1 }]),
      listGitLabRepoLabels: vi.fn().mockResolvedValue(['bug']),
      createGitLabRepoIssue: vi.fn().mockResolvedValue({ ok: true, number: 7 }),
      updateGitLabRepoIssue: vi.fn().mockResolvedValue({ ok: true }),
      addGitLabRepoIssueComment: vi.fn().mockResolvedValue({ ok: true }),
      addGitLabRepoMRComment: vi.fn().mockResolvedValue({ ok: true }),
      addGitLabRepoMRInlineComment: vi.fn().mockResolvedValue({ ok: true }),
      resolveGitLabRepoMRDiscussion: vi.fn().mockResolvedValue({ ok: true }),
      getGitLabRepoJobTrace: vi.fn().mockResolvedValue({ ok: true, trace: 'log' }),
      retryGitLabRepoJob: vi.fn().mockResolvedValue({ ok: true }),
      mergeGitLabRepoMR: vi.fn().mockResolvedValue({ ok: true }),
      updateGitLabRepoMRState: vi.fn().mockResolvedValue({ ok: true }),
      updateGitLabRepoMR: vi.fn().mockResolvedValue({ ok: true }),
      updateGitLabRepoMRReviewers: vi.fn().mockResolvedValue({ ok: true, reviewers: [] }),
      getGitLabRepoWorkItemDetails: vi.fn().mockResolvedValue({ body: 'Details' }),
      getGitLabRepoWorkItemByPath: vi.fn().mockResolvedValue({ id: 'gitlab-issue-7' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })
    const projectRef = { host: 'gitlab.example.com', path: 'group/project' }

    await dispatcher.dispatch(makeRequest('gitlab.diagnoseAuth'))
    await dispatcher.dispatch(
      makeRequest('gitlab.rateLimit', { force: true, host: 'gitlab.example.com' })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.listMRs', {
        repo: 'id:repo-1',
        state: 'opened',
        page: 1,
        perPage: 25,
        query: 'bug'
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.listWorkItems', {
        repo: 'id:repo-1',
        state: 'opened',
        page: 1,
        perPage: 25,
        query: 'bug'
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.listIssues', {
        repo: 'id:repo-1',
        state: 'opened',
        assignee: '@me',
        limit: 50,
        page: 2
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.createIssue', {
        repo: 'id:repo-1',
        title: 'Fix bug',
        body: 'Details'
      })
    )
    await dispatcher.dispatch(makeRequest('gitlab.todos', { repo: 'id:repo-1' }))
    await dispatcher.dispatch(makeRequest('gitlab.listLabels', { repo: 'id:repo-1' }))
    await dispatcher.dispatch(
      makeRequest('gitlab.updateIssue', {
        repo: 'id:repo-1',
        number: 7,
        updates: { state: 'closed', title: 'Done', body: 'Updated body' },
        projectRef
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.addIssueComment', {
        repo: 'id:repo-1',
        number: 7,
        body: 'looks good',
        projectRef
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.addMRComment', {
        repo: 'id:repo-1',
        iid: 8,
        body: 'ship it',
        projectRef
      })
    )
    const inlineInput = {
      body: 'please fix',
      path: 'src/app.ts',
      line: 12,
      baseSha: 'base',
      startSha: 'start',
      headSha: 'head'
    }
    await dispatcher.dispatch(
      makeRequest('gitlab.addMRInlineComment', {
        repo: 'id:repo-1',
        iid: 8,
        input: inlineInput,
        projectRef
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.resolveMRDiscussion', {
        repo: 'id:repo-1',
        iid: 8,
        discussionId: 'discussion-1',
        resolved: true,
        projectRef
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.jobTrace', {
        repo: 'id:repo-1',
        jobId: 99,
        projectRef
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.retryJob', {
        repo: 'id:repo-1',
        jobId: 99,
        projectRef
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.mergeMR', {
        repo: 'id:repo-1',
        iid: 8,
        method: 'squash',
        projectRef
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.updateMRState', {
        repo: 'id:repo-1',
        iid: 8,
        state: 'closed',
        projectRef
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.updateMR', {
        repo: 'id:repo-1',
        iid: 8,
        updates: { title: 'New title', body: 'New body', addLabels: ['bug'] },
        projectRef
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.updateMRReviewers', {
        repo: 'id:repo-1',
        iid: 8,
        reviewerIds: [1, 2],
        projectRef
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.workItemDetails', {
        repo: 'id:repo-1',
        iid: 8,
        type: 'mr',
        projectRef
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.workItemByPath', {
        repo: 'id:repo-1',
        host: 'gitlab.example.com',
        path: 'group/project',
        iid: 7,
        type: 'issue'
      })
    )

    expect(runtime.diagnoseGitLabAuth).toHaveBeenCalledWith()
    expect(runtime.getGitLabRateLimit).toHaveBeenCalledWith({
      force: true,
      host: 'gitlab.example.com'
    })
    expect(runtime.listGitLabRepoMRs).toHaveBeenCalledWith('id:repo-1', 'opened', 1, 25, 'bug')
    expect(runtime.listGitLabRepoWorkItems).toHaveBeenCalledWith(
      'id:repo-1',
      'opened',
      1,
      25,
      'bug'
    )
    expect(runtime.listGitLabRepoIssues).toHaveBeenCalledWith('id:repo-1', 'opened', '@me', 50, 2)
    expect(runtime.createGitLabRepoIssue).toHaveBeenCalledWith('id:repo-1', 'Fix bug', 'Details')
    expect(runtime.listGitLabRepoTodos).toHaveBeenCalledWith('id:repo-1')
    expect(runtime.listGitLabRepoLabels).toHaveBeenCalledWith('id:repo-1')
    expect(runtime.updateGitLabRepoIssue).toHaveBeenCalledWith(
      'id:repo-1',
      7,
      {
        state: 'closed',
        title: 'Done',
        body: 'Updated body'
      },
      projectRef
    )
    expect(runtime.addGitLabRepoIssueComment).toHaveBeenCalledWith(
      'id:repo-1',
      7,
      'looks good',
      projectRef
    )
    expect(runtime.addGitLabRepoMRComment).toHaveBeenCalledWith(
      'id:repo-1',
      8,
      'ship it',
      projectRef
    )
    expect(runtime.addGitLabRepoMRInlineComment).toHaveBeenCalledWith(
      'id:repo-1',
      8,
      inlineInput,
      projectRef
    )
    expect(runtime.resolveGitLabRepoMRDiscussion).toHaveBeenCalledWith(
      'id:repo-1',
      8,
      'discussion-1',
      true,
      projectRef
    )
    expect(runtime.getGitLabRepoJobTrace).toHaveBeenCalledWith('id:repo-1', 99, projectRef)
    expect(runtime.retryGitLabRepoJob).toHaveBeenCalledWith('id:repo-1', 99, projectRef)
    expect(runtime.mergeGitLabRepoMR).toHaveBeenCalledWith('id:repo-1', 8, 'squash', projectRef)
    expect(runtime.updateGitLabRepoMRState).toHaveBeenCalledWith(
      'id:repo-1',
      8,
      'closed',
      projectRef
    )
    expect(runtime.updateGitLabRepoMR).toHaveBeenCalledWith(
      'id:repo-1',
      8,
      {
        title: 'New title',
        body: 'New body',
        addLabels: ['bug']
      },
      projectRef
    )
    expect(runtime.updateGitLabRepoMRReviewers).toHaveBeenCalledWith(
      'id:repo-1',
      8,
      [1, 2],
      projectRef
    )
    expect(runtime.getGitLabRepoWorkItemDetails).toHaveBeenCalledWith(
      'id:repo-1',
      8,
      'mr',
      projectRef
    )
    expect(runtime.getGitLabRepoWorkItemByPath).toHaveBeenCalledWith(
      'id:repo-1',
      { host: 'gitlab.example.com', path: 'group/project' },
      7,
      'issue'
    )
  })

  it('accepts the negotiated ready-for-review update field', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateGitLabRepoMR: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('gitlab.updateMR', {
        repo: 'id:repo-1',
        iid: 8,
        updates: { readyForReview: true }
      })
    )

    expect(runtime.updateGitLabRepoMR).toHaveBeenCalledWith(
      'id:repo-1',
      8,
      { readyForReview: true },
      undefined
    )
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('normalizes GitLab issue list arguments to match desktop preload behavior', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listGitLabRepoIssues: vi.fn().mockResolvedValue({ items: [] })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })

    await dispatcher.dispatch(
      makeRequest('gitlab.listIssues', {
        repo: 'id:repo-1',
        state: 'closed',
        assignee: 'someone-else',
        limit: 250.8
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitlab.listIssues', {
        repo: 'id:repo-1',
        state: 'unexpected',
        assignee: '@me',
        limit: -4
      })
    )

    expect(runtime.listGitLabRepoIssues).toHaveBeenNthCalledWith(
      1,
      'id:repo-1',
      'closed',
      undefined,
      100,
      1
    )
    expect(runtime.listGitLabRepoIssues).toHaveBeenNthCalledWith(
      2,
      'id:repo-1',
      'opened',
      '@me',
      1,
      1
    )
  })

  // Regression for #7732: the WS/relay transports close the connection on frames
  // over 1 MB, so the excerpt must be produced before the response is serialised.
  it('bounds the job trace before it crosses the transport when logExcerpt is set', async () => {
    const noisyTrace = [
      'section_start:1699000000:build\r\u001b[0K$ pnpm build',
      ...Array.from({ length: 400 }, (_, index) => `line ${index}`),
      'ERROR: Job failed: exit code 1'
    ].join('\n')
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getGitLabRepoJobTrace: vi.fn().mockResolvedValue({ ok: true, trace: noisyTrace })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })

    const raw = await dispatcher.dispatch(
      makeRequest('gitlab.jobTrace', { repo: 'id:repo-1', jobId: 99 })
    )
    const excerpt = await dispatcher.dispatch(
      makeRequest('gitlab.jobTrace', { repo: 'id:repo-1', jobId: 99, logExcerpt: true })
    )

    expect((raw as { result: { trace: string } }).result.trace).toBe(noisyTrace)
    const bounded = (excerpt as { result: { trace: string } }).result.trace
    expect(bounded).toContain('ERROR: Job failed: exit code 1')
    expect(bounded).not.toContain('section_start')
    expect(bounded).not.toContain('line 0\n')
  })

  // Why: a client-supplied host/projectRef is a `glab --hostname` override that
  // skips remote resolution, so a crafted RPC payload could otherwise aim
  // credentialed glab calls at an arbitrary GitLab.
  describe('configured-instance host guard', () => {
    const OTHER_HOST = 'gitlab.evil.test'

    function makeGuardRuntime(): OrcaRuntimeService {
      return {
        getRuntimeId: () => 'test-runtime',
        getGitLabRateLimit: vi.fn().mockResolvedValue({ ok: true }),
        getGitLabRepoJobTrace: vi.fn().mockResolvedValue({ ok: true }),
        retryGitLabRepoJob: vi.fn().mockResolvedValue({ ok: true }),
        updateGitLabRepoMRReviewers: vi.fn().mockResolvedValue({ ok: true }),
        addGitLabRepoMRInlineComment: vi.fn().mockResolvedValue({ ok: true }),
        getGitLabRepoWorkItemDetails: vi.fn().mockResolvedValue({ body: 'Details' }),
        getGitLabRepoWorkItemByPath: vi.fn().mockResolvedValue({ id: 'gitlab-issue-7' })
      } as unknown as OrcaRuntimeService
    }

    const inlineInput = {
      body: 'Inline',
      path: 'src/a.ts',
      line: 12,
      baseSha: 'base',
      startSha: 'start',
      headSha: 'head'
    }

    it.each([
      ['gitlab.jobTrace', { jobId: 99 }, 'getGitLabRepoJobTrace'],
      ['gitlab.retryJob', { jobId: 99 }, 'retryGitLabRepoJob'],
      ['gitlab.updateMRReviewers', { iid: 8, reviewerIds: [1] }, 'updateGitLabRepoMRReviewers'],
      [
        'gitlab.addMRInlineComment',
        { iid: 8, input: inlineInput },
        'addGitLabRepoMRInlineComment'
      ],
      ['gitlab.workItemDetails', { iid: 8, type: 'mr' }, 'getGitLabRepoWorkItemDetails']
    ])('rejects %s for a projectRef on another host', async (method, args, runtimeMethod) => {
      const runtime = makeGuardRuntime()
      const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })

      const response = await dispatcher.dispatch(
        makeRequest(method as string, {
          repo: 'id:repo-1',
          ...(args as object),
          projectRef: { host: OTHER_HOST, path: 'attacker/exfil' }
        })
      )

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument', message: expect.stringContaining('does not match') }
      })
      expect(runtime[runtimeMethod as keyof OrcaRuntimeService]).not.toHaveBeenCalled()
    })

    it('rejects a pasted work item on another host', async () => {
      const runtime = makeGuardRuntime()
      const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })

      const response = await dispatcher.dispatch(
        makeRequest('gitlab.workItemByPath', {
          repo: 'id:repo-1',
          host: OTHER_HOST,
          path: 'attacker/exfil',
          iid: 1,
          type: 'issue'
        })
      )

      expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
      expect(runtime.getGitLabRepoWorkItemByPath).not.toHaveBeenCalled()
    })

    it('rejects a rateLimit host on another host', async () => {
      const runtime = makeGuardRuntime()
      const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })

      const response = await dispatcher.dispatch(
        makeRequest('gitlab.rateLimit', { force: true, host: OTHER_HOST })
      )

      expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
      expect(runtime.getGitLabRateLimit).not.toHaveBeenCalled()
    })

    it('rejects any supplied host when no GitLab instance is configured', async () => {
      setConfiguredGitLabUrl('')
      const runtime = makeGuardRuntime()
      const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })

      for (const request of [
        makeRequest('gitlab.rateLimit', { host: 'gitlab.example.com' }),
        makeRequest('gitlab.workItemByPath', {
          repo: 'id:repo-1',
          host: 'gitlab.example.com',
          path: 'g/p',
          iid: 1,
          type: 'issue'
        }),
        makeRequest('gitlab.jobTrace', {
          repo: 'id:repo-1',
          jobId: 99,
          projectRef: { host: 'gitlab.example.com', path: 'g/p' }
        })
      ]) {
        expect(await dispatcher.dispatch(request)).toMatchObject({
          ok: false,
          error: {
            code: 'invalid_argument',
            message: expect.stringContaining('no GitLab instance is configured')
          }
        })
      }
      expect(runtime.getGitLabRateLimit).not.toHaveBeenCalled()
      expect(runtime.getGitLabRepoWorkItemByPath).not.toHaveBeenCalled()
      expect(runtime.getGitLabRepoJobTrace).not.toHaveBeenCalled()
    })

    it('canonicalizes a matching host before it reaches the runtime', async () => {
      const runtime = makeGuardRuntime()
      const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })

      await dispatcher.dispatch(
        makeRequest('gitlab.rateLimit', { host: ' GitLab.Example.COM ' })
      )
      await dispatcher.dispatch(
        makeRequest('gitlab.workItemByPath', {
          repo: 'id:repo-1',
          host: 'GITLAB.example.com',
          path: 'g/p',
          iid: 7,
          type: 'issue'
        })
      )
      await dispatcher.dispatch(
        makeRequest('gitlab.jobTrace', {
          repo: 'id:repo-1',
          jobId: 99,
          projectRef: { host: 'GitLab.Example.com', path: 'g/p' }
        })
      )

      expect(runtime.getGitLabRateLimit).toHaveBeenCalledWith({ host: 'gitlab.example.com' })
      expect(runtime.getGitLabRepoWorkItemByPath).toHaveBeenCalledWith(
        'id:repo-1',
        { host: 'gitlab.example.com', path: 'g/p' },
        7,
        'issue'
      )
      expect(runtime.getGitLabRepoJobTrace).toHaveBeenCalledWith('id:repo-1', 99, {
        host: 'gitlab.example.com',
        path: 'g/p'
      })
    })

    it('leaves an omitted host on the resolved-remote path', async () => {
      const runtime = makeGuardRuntime()
      const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })

      await dispatcher.dispatch(makeRequest('gitlab.rateLimit', { force: true }))
      await dispatcher.dispatch(makeRequest('gitlab.jobTrace', { repo: 'id:repo-1', jobId: 99 }))

      expect(runtime.getGitLabRateLimit).toHaveBeenCalledWith({ force: true })
      expect(runtime.getGitLabRepoJobTrace).toHaveBeenCalledWith('id:repo-1', 99, undefined)
    })
  })
})
