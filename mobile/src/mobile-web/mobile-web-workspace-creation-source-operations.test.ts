import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebWorkspaceCreationSourceOperation } from './mobile-web-workspace-creation-source-operations'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

describe('mobile web workspace creation sources', () => {
  it('uses opaque repo authority and strips provider credentials and extra fields', async () => {
    const authority = workspaceAuthority()
    authority.synchronizeCreationRepositories([{ id: 'host-repo-secret' }])
    const pageRepoId = authority.pageRepoId('host-repo-secret')
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        items: [
          {
            id: 'durable-provider-id',
            type: 'pr',
            number: 7,
            title: 'Secure item',
            state: 'open',
            url: 'https://token:secret@github.example.com/acme/orca/pull/7?access=secret#private',
            labels: ['mobile'],
            updatedAt: '2026-07-23T00:00:00Z',
            author: 'octo',
            headSha: 'host-only-sha',
            repoId: 'host-repo-secret'
          }
        ]
      }
    })

    const result = await executeMobileWebWorkspaceCreationSourceOperation({
      operation: 'creationSearchGitHub',
      payload: { repoId: pageRepoId, query: 'mobile' },
      client: { sendRequest } as unknown as RpcClient,
      authority
    })

    expect(sendRequest).toHaveBeenCalledWith('github.listWorkItems', {
      repo: 'id:host-repo-secret',
      limit: 36,
      query: 'mobile'
    })
    expect(result).toEqual({
      items: [
        expect.objectContaining({
          id: `github:${pageRepoId}:pr:7`,
          repoId: pageRepoId,
          url: 'https://github.example.com/acme/orca/pull/7'
        })
      ]
    })
    expect(JSON.stringify(result)).not.toMatch(
      /token|secret|durable-provider-id|host-only-sha|host-repo-secret/
    )
  })

  it('removes fork remote URLs from hosted base presentations', async () => {
    const authority = workspaceAuthority()
    authority.synchronizeCreationRepositories([{ id: 'host-repo-secret' }])
    const pageRepoId = authority.pageRepoId('host-repo-secret')
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        baseBranch: 'refs/pull/7/head',
        compareBaseRef: 'origin/main',
        pushTarget: {
          remoteName: 'contributor',
          branchName: 'feature',
          remoteUrl: 'https://token:secret@example.com/contributor/orca.git'
        }
      }
    })

    const result = await executeMobileWebWorkspaceCreationSourceOperation({
      operation: 'creationResolvePrBase',
      payload: { repoId: pageRepoId, prNumber: 7 },
      client: { sendRequest } as unknown as RpcClient,
      authority
    })

    expect(result).toEqual({
      baseBranch: 'refs/pull/7/head',
      compareBaseRef: 'origin/main',
      pushTarget: { remoteName: 'contributor', branchName: 'feature' }
    })
    expect(JSON.stringify(result)).not.toContain('remoteUrl')
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('maps the SSH GitHub remote requirement without exposing host errors', async () => {
    const authority = workspaceAuthority()
    authority.synchronizeCreationRepositories([{ id: 'host-repo-secret' }])
    const pageRepoId = authority.pageRepoId('host-repo-secret')
    const sendRequest = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'runtime_error',
        message: 'GitHub work items require a GitHub remote for SSH repositories: secret-host'
      }
    })

    await expect(
      executeMobileWebWorkspaceCreationSourceOperation({
        operation: 'creationSearchGitHub',
        payload: { repoId: pageRepoId, query: 'mobile' },
        client: { sendRequest } as unknown as RpcClient,
        authority
      })
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

function workspaceAuthority(): MobileWebWorkspaceAuthority {
  return new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(9))
}
