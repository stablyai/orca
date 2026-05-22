import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { GITLAB_METHODS } from './gitlab'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('gitlab RPC methods', () => {
  it('routes GitLab task queries and mutations to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listGitLabRepoWorkItems: vi.fn().mockResolvedValue({ items: [] }),
      listGitLabRepoTodos: vi.fn().mockResolvedValue([{ id: 1 }]),
      createGitLabRepoIssue: vi.fn().mockResolvedValue({ ok: true, number: 7 }),
      updateGitLabRepoIssue: vi.fn().mockResolvedValue({ ok: true }),
      addGitLabRepoIssueComment: vi.fn().mockResolvedValue({ ok: true }),
      addGitLabRepoMRComment: vi.fn().mockResolvedValue({ ok: true }),
      mergeGitLabRepoMR: vi.fn().mockResolvedValue({ ok: true }),
      updateGitLabRepoMRState: vi.fn().mockResolvedValue({ ok: true }),
      updateGitLabRepoMR: vi.fn().mockResolvedValue({ ok: true }),
      getGitLabRepoWorkItemDetails: vi.fn().mockResolvedValue({ body: 'Details' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })
    const projectRef = { host: 'gitlab.example.com', path: 'group/project' }

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
      makeRequest('gitlab.createIssue', {
        repo: 'id:repo-1',
        title: 'Fix bug',
        body: 'Details'
      })
    )
    await dispatcher.dispatch(makeRequest('gitlab.todos', { repo: 'id:repo-1' }))
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
      makeRequest('gitlab.workItemDetails', {
        repo: 'id:repo-1',
        iid: 8,
        type: 'mr',
        projectRef
      })
    )

    expect(runtime.listGitLabRepoWorkItems).toHaveBeenCalledWith(
      'id:repo-1',
      'opened',
      1,
      25,
      'bug'
    )
    expect(runtime.createGitLabRepoIssue).toHaveBeenCalledWith('id:repo-1', 'Fix bug', 'Details')
    expect(runtime.listGitLabRepoTodos).toHaveBeenCalledWith('id:repo-1')
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
    expect(runtime.getGitLabRepoWorkItemDetails).toHaveBeenCalledWith(
      'id:repo-1',
      8,
      'mr',
      projectRef
    )
  })
})
