import { describe, expect, it, vi } from 'vitest'
import { MOBILE_WORKTREE_CREATE_IDEMPOTENCY_CAPABILITY } from '../tasks/worktree-create-capability'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebWorkspaceCreationCreateOperation } from './mobile-web-workspace-creation-create-operations'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

describe('mobile web workspace creation writes', () => {
  it('revalidates a PR and its fork base natively before creating', async () => {
    const authority = workspaceAuthority()
    authority.synchronizeCreationRepositories([{ id: 'host-repo-secret' }])
    const pageRepoId = authority.pageRepoId('host-repo-secret')
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return {
          ok: true,
          result: { capabilities: [MOBILE_WORKTREE_CREATE_IDEMPOTENCY_CAPABILITY] }
        }
      }
      if (method === 'github.workItem') {
        return {
          ok: true,
          result: {
            id: 'provider-secret-id',
            type: 'pr',
            number: 7,
            title: 'Authoritative title',
            state: 'open',
            url: 'https://github.example.com/acme/orca/pull/7',
            labels: [],
            updatedAt: '2026-07-23T00:00:00Z',
            author: null,
            branchName: 'authoritative-head',
            baseRefName: 'main',
            isCrossRepository: true
          }
        }
      }
      if (method === 'worktree.resolvePrBase') {
        return {
          ok: true,
          result: {
            baseBranch: 'refs/pull/7/head',
            compareBaseRef: 'origin/main',
            pushTarget: {
              remoteName: 'contributor',
              branchName: 'authoritative-head',
              remoteUrl: 'git@github.example.com:contributor/orca.git'
            }
          }
        }
      }
      if (method === 'settings.get') {
        return {
          ok: true,
          result: { settings: { agentCmdOverrides: { codex: 'TOKEN=secret codex' } } }
        }
      }
      if (method === 'worktree.create') {
        return {
          ok: true,
          result: {
            worktree: { id: '/host/worktree-secret' },
            warning: 'Setup completed with a warning.'
          }
        }
      }
      throw new Error(`Unexpected method ${method}`)
    })

    const result = await executeMobileWebWorkspaceCreationCreateOperation({
      operation: 'creationCreateFromSource',
      payload: {
        selection: {
          kind: 'work-item',
          item: {
            provider: 'github',
            type: 'pr',
            number: 7,
            title: 'Tampered page title',
            url: 'https://github.example.com/attacker/fake/pull/7',
            repoId: pageRepoId
          },
          baseBranch: 'attacker/base',
          compareBaseRef: 'attacker/compare',
          pushTarget: { remoteName: 'attacker', branchName: 'attacker-branch' }
        },
        targetRepoId: pageRepoId,
        setupDecision: 'skip',
        agentChoice: 'codex',
        sparseCheckout: {
          directories: ['src/renderer'],
          presetId: 'renderer'
        }
      },
      client: { sendRequest } as unknown as RpcClient,
      authority
    })

    expect(sendRequest).toHaveBeenCalledWith('github.workItem', {
      repo: 'id:host-repo-secret',
      number: 7
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'worktree.resolvePrBase',
      {
        repo: 'id:host-repo-secret',
        prNumber: 7,
        headRefName: 'authoritative-head',
        baseRefName: 'main',
        isCrossRepository: true
      },
      { timeoutMs: 30_000 }
    )
    expect(sendRequest).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({
        repo: 'id:host-repo-secret',
        baseBranch: 'refs/pull/7/head',
        compareBaseRef: 'origin/main',
        pushTarget: {
          remoteName: 'contributor',
          branchName: 'authoritative-head',
          remoteUrl: 'git@github.example.com:contributor/orca.git'
        },
        startupDraft: 'https://github.example.com/acme/orca/pull/7',
        createdWithAgent: 'codex',
        sparseCheckout: {
          directories: ['src/renderer'],
          presetId: 'renderer'
        }
      }),
      expect.anything()
    )
    expect(result).toEqual({
      workspaceId: expect.stringMatching(/^workspace_/),
      name: 'pr-7',
      warning: 'Setup completed with a warning.'
    })
    expect(JSON.stringify(result)).not.toMatch(/host|secret|provider/)
  })

  it('rejects a page-supplied native repository ID', async () => {
    const authority = workspaceAuthority()
    authority.synchronizeCreationRepositories([{ id: 'host-repo-secret' }])

    await expect(
      executeMobileWebWorkspaceCreationCreateOperation({
        operation: 'creationCreateBlank',
        payload: blankPayload('host-repo-secret'),
        client: {
          sendRequest: vi.fn().mockResolvedValue({ ok: true, result: { capabilities: [] } })
        } as unknown as RpcClient,
        authority
      })
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

function blankPayload(repoId: string) {
  return {
    repoId,
    baseName: 'secure-workspace',
    nameWasGenerated: false,
    agentChoice: 'blank',
    setupDecision: 'skip'
  }
}

function workspaceAuthority(): MobileWebWorkspaceAuthority {
  return new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(4))
}
