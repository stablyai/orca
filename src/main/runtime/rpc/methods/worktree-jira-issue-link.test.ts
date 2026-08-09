import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { WORKTREE_METHODS } from './worktree'

describe('worktree Jira issue link RPC', () => {
  it('forwards dedicated Jira metadata through worktree.set', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateManagedWorktreeMeta: vi.fn().mockResolvedValue({ id: 'wt-1' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    const linkedJiraIssue = {
      key: 'ORCA-123',
      title: 'Link Jira',
      url: 'https://company.atlassian.net/browse/ORCA-123'
    }
    const linkedJiraIssueSourceContext = {
      kind: 'task-source',
      provider: 'jira',
      projectId: 'project-1',
      hostId: 'runtime:env-1',
      providerIdentity: {
        provider: 'jira',
        siteId: 'site-1',
        siteUrl: 'https://company.atlassian.net',
        projectKey: 'ORCA'
      }
    }
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.set',
      params: { worktree: 'id:wt-1', linkedJiraIssue, linkedJiraIssueSourceContext }
    }

    const response = await dispatcher.dispatch(request)

    expect(response).toMatchObject({ ok: true })
    expect(runtime.updateManagedWorktreeMeta).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({
        linkedJiraIssue,
        linkedJiraIssueSourceContext: expect.objectContaining(linkedJiraIssueSourceContext)
      })
    )
  })
})
