import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebWorkspaceCreationCreateOperation } from './mobile-web-workspace-creation-create-operations'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

describe('mobile web workspace creation provider revalidation', () => {
  it('repeats GitLab MR lookup and base resolution with native repository authority', async () => {
    const { authority, pageRepoId } = repositoryAuthority()
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return { ok: true, result: { capabilities: [] } }
      }
      if (method === 'gitlab.workItemByPath') {
        return {
          ok: true,
          result: {
            id: 'gitlab-durable-secret',
            type: 'mr',
            number: 9,
            title: 'Authoritative MR',
            state: 'opened',
            url: 'https://gitlab.example.com/group/orca/-/merge_requests/9',
            labels: [],
            updatedAt: '2026-07-23T00:00:00Z',
            author: null,
            branchName: 'trusted-head',
            baseRefName: 'main',
            isCrossRepository: true
          }
        }
      }
      if (method === 'worktree.resolveMrBase') {
        return {
          ok: true,
          result: {
            baseBranch: 'refs/merge-requests/9/head',
            compareBaseRef: 'origin/main',
            pushTarget: {
              remoteName: 'contributor',
              branchName: 'trusted-head',
              remoteUrl: 'git@gitlab.example.com:contributor/orca.git'
            }
          }
        }
      }
      if (method === 'worktree.create') {
        return { ok: true, result: { worktree: { id: '/host/gitlab-worktree' } } }
      }
      throw new Error(`Unexpected method ${method}`)
    })

    const result = await createFromSource({
      authority,
      sendRequest,
      pageRepoId,
      selection: {
        kind: 'work-item',
        item: {
          provider: 'gitlab',
          type: 'mr',
          number: 9,
          title: 'Page title',
          url: 'https://gitlab.example.com/group/orca/-/merge_requests/9',
          repoId: pageRepoId
        },
        baseBranch: 'page/base'
      }
    })

    expect(sendRequest).toHaveBeenCalledWith('gitlab.workItemByPath', {
      repo: 'id:host-repo-secret',
      host: 'gitlab.example.com',
      path: 'group/orca',
      iid: 9,
      type: 'mr'
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'worktree.resolveMrBase',
      {
        repo: 'id:host-repo-secret',
        mrIid: 9,
        sourceBranch: 'trusted-head',
        targetBranch: 'main',
        isCrossRepository: true
      },
      { timeoutMs: 30_000 }
    )
    expect(sendRequest).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({
        repo: 'id:host-repo-secret',
        baseBranch: 'refs/merge-requests/9/head',
        linkedGitLabMR: 9
      }),
      { timeoutMs: 600_000 }
    )
    expect(result).toEqual({
      workspaceId: expect.stringMatching(/^workspace_/),
      name: 'mr-9'
    })
  })

  it('re-searches Linear by exact identifier and ignores page metadata', async () => {
    const { authority, pageRepoId } = repositoryAuthority()
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return { ok: true, result: { capabilities: [] } }
      }
      if (method === 'linear.searchIssues') {
        return {
          ok: true,
          result: {
            items: [
              linearIssue('OTHER-1', 'Wrong issue'),
              linearIssue('ENG-42', 'Authoritative Linear title')
            ]
          }
        }
      }
      if (method === 'worktree.create') {
        return { ok: true, result: { worktree: { id: '/host/linear-worktree' } } }
      }
      throw new Error(`Unexpected method ${method}`)
    })

    const result = await createFromSource({
      authority,
      sendRequest,
      pageRepoId,
      selection: {
        kind: 'work-item',
        item: {
          provider: 'linear',
          type: 'issue',
          number: 0,
          title: 'Page-controlled title',
          url: 'https://linear.app/attacker/issue/ENG-42/fake',
          linearIdentifier: 'eng-42'
        },
        branchNameOverride: 'trusted-user-override'
      }
    })

    expect(sendRequest).toHaveBeenCalledWith('linear.searchIssues', {
      query: 'eng-42',
      limit: 50,
      workspaceId: undefined
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({
        repo: 'id:host-repo-secret',
        linkedLinearIssue: 'ENG-42',
        linkedLinearIssueWorkspaceId: 'linear-workspace-secret',
        displayName: 'ENG-42 Authoritative Linear title',
        linkedLinearIssueOrganizationUrlKey: 'acme'
      }),
      { timeoutMs: 600_000 }
    )
    expect(result).toEqual({
      workspaceId: expect.stringMatching(/^workspace_/),
      name: 'eng-42'
    })
    expect(JSON.stringify(result)).not.toMatch(/host|secret|linear-workspace/)
  })
})

function createFromSource(args: {
  authority: MobileWebWorkspaceAuthority
  sendRequest: ReturnType<typeof vi.fn>
  pageRepoId: string
  selection: unknown
}) {
  return executeMobileWebWorkspaceCreationCreateOperation({
    operation: 'creationCreateFromSource',
    payload: {
      selection: args.selection,
      targetRepoId: args.pageRepoId,
      setupDecision: 'skip',
      agentChoice: 'blank'
    },
    client: { sendRequest: args.sendRequest } as unknown as RpcClient,
    authority: args.authority
  })
}

function repositoryAuthority() {
  const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(6))
  authority.synchronizeCreationRepositories([{ id: 'host-repo-secret' }])
  return { authority, pageRepoId: authority.pageRepoId('host-repo-secret') }
}

function linearIssue(identifier: string, title: string) {
  return {
    id: `linear-id-${identifier}`,
    workspaceId: 'linear-workspace-secret',
    identifier,
    title,
    branchName: `branch-${identifier}`,
    url: `https://linear.app/acme/issue/${identifier}/authoritative`,
    state: { name: 'Todo', type: 'unstarted', color: '#737373' },
    team: { id: 'team-secret', name: 'Engineering', key: 'ENG' },
    labels: [],
    labelIds: [],
    priority: 1,
    updatedAt: '2026-07-23T00:00:00Z'
  }
}
