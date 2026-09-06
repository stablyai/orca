import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebWorkspaceCreationReadOperation } from './mobile-web-workspace-creation-read-operations'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

function authority(): MobileWebWorkspaceAuthority {
  return new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(7))
}

describe('mobile web workspace creation reads', () => {
  it('returns presentation data with opaque repository, project, and execution authority', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        repos: [
          {
            id: '/host/repo-id',
            displayName: 'Orca',
            path: '/Users/private/orca',
            connectionId: 'ssh-secret-target',
            kind: 'git',
            upstream: { owner: 'acme', repo: 'orca' },
            gitRemoteIdentity: { remoteUrl: 'git@secret.example:acme/orca.git' }
          }
        ]
      }
    })
    const workspaceAuthority = authority()

    const result = await executeMobileWebWorkspaceCreationReadOperation({
      operation: 'creationRepositories',
      payload: {},
      client: { sendRequest } as unknown as RpcClient,
      authority: workspaceAuthority
    })

    expect(result).toEqual({
      repositories: [
        {
          id: expect.stringMatching(/^repo_/),
          displayName: 'Orca',
          path: '/Users/private/orca',
          connectionId: expect.stringMatching(/^repo_/),
          executionHostId: expect.stringMatching(/^ssh:executionHost_/),
          executionHostLabel: 'Host',
          projectId: expect.stringMatching(/^project_/),
          upstream: { owner: 'acme', repo: 'orca' },
          kind: 'git'
        }
      ]
    })
    expect(JSON.stringify(result)).not.toContain('ssh-secret-target')
    expect(JSON.stringify(result)).not.toContain('/host/repo-id')
    expect(JSON.stringify(result)).not.toContain('secret.example')
  })

  it('resolves the opaque repository to native SSH authority and sanitizes errors', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: {
          repos: [
            {
              id: 'host-repo',
              displayName: 'Remote',
              path: '/remote/private',
              connectionId: 'host-ssh-target'
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          state: {
            targetId: 'host-ssh-target',
            status: 'error',
            error: 'private-key /Users/private/.ssh/id_ed25519 rejected',
            reconnectAttempt: 2,
            connectionGeneration: 99
          }
        }
      })
    const workspaceAuthority = authority()
    const repositories = (await executeMobileWebWorkspaceCreationReadOperation({
      operation: 'creationRepositories',
      payload: {},
      client: { sendRequest } as unknown as RpcClient,
      authority: workspaceAuthority
    })) as { repositories: { id: string }[] }

    const result = await executeMobileWebWorkspaceCreationReadOperation({
      operation: 'creationSshState',
      payload: { repoId: repositories.repositories[0]!.id },
      client: { sendRequest } as unknown as RpcClient,
      authority: workspaceAuthority
    })

    expect(sendRequest).toHaveBeenLastCalledWith('ssh.getState', {
      targetId: 'host-ssh-target'
    })
    expect(result).toEqual({
      targetId: repositories.repositories[0]!.id,
      status: 'error',
      error: 'SSH connection failed.',
      reconnectAttempt: 2
    })
    expect(JSON.stringify(result)).not.toContain('private-key')
    expect(JSON.stringify(result)).not.toContain('connectionGeneration')
  })

  it('reads retired names through opaque repository authority', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { repos: [{ id: 'host-repo', displayName: 'Orca', path: '/workspace/orca' }] }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          retiredNamesByRepo: { 'host-repo': ['nautilus'] },
          retiredNameTiersByRepo: { 'host-repo': 2 }
        }
      })
    const workspaceAuthority = authority()
    const listed = (await executeMobileWebWorkspaceCreationReadOperation({
      operation: 'creationRepositories',
      payload: {},
      client: { sendRequest } as unknown as RpcClient,
      authority: workspaceAuthority
    })) as { repositories: { id: string }[] }
    const repoId = listed.repositories[0]!.id

    await expect(
      executeMobileWebWorkspaceCreationReadOperation({
        operation: 'creationRetiredNames',
        payload: { repoId },
        client: { sendRequest } as unknown as RpcClient,
        authority: workspaceAuthority
      })
    ).resolves.toEqual({ exhaustedTiers: 2, names: ['nautilus'] })
    expect(sendRequest).toHaveBeenLastCalledWith('worktree.listRetiredNames', {
      repo: 'id:host-repo'
    })
  })

  it('never returns configured launch commands with page settings', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        settings: {
          defaultTuiAgent: 'codex',
          disabledTuiAgents: ['claude'],
          visibleTaskProviders: ['github', 'invalid'],
          agentCmdOverrides: { codex: 'TOKEN=secret codex' }
        }
      }
    })

    const result = await executeMobileWebWorkspaceCreationReadOperation({
      operation: 'creationSettings',
      payload: {},
      client: { sendRequest } as unknown as RpcClient,
      authority: authority()
    })

    expect(result).toEqual({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: ['claude'],
      visibleTaskProviders: ['github']
    })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('keeps sparse presets behind opaque repository authority', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'repo.list') {
        return {
          ok: true,
          result: {
            repos: [{ id: 'host-repo', displayName: 'Orca', path: '/private/orca' }]
          }
        }
      }
      const preset = {
        id: 'preset-1',
        repoId: 'host-repo',
        name: 'Mobile',
        directories: ['mobile'],
        createdAt: 1,
        updatedAt: 2
      }
      return method === 'repo.sparsePresets'
        ? { ok: true, result: { presets: [preset] } }
        : { ok: true, result: { preset } }
    })
    const workspaceAuthority = authority()
    const repositories = (await executeMobileWebWorkspaceCreationReadOperation({
      operation: 'creationRepositories',
      payload: {},
      client: { sendRequest } as unknown as RpcClient,
      authority: workspaceAuthority
    })) as { repositories: { id: string }[] }
    const repoId = repositories.repositories[0]!.id

    const listed = await executeMobileWebWorkspaceCreationReadOperation({
      operation: 'creationSparsePresets',
      payload: { repoId },
      client: { sendRequest } as unknown as RpcClient,
      authority: workspaceAuthority
    })
    const saved = await executeMobileWebWorkspaceCreationReadOperation({
      operation: 'creationSaveSparsePreset',
      payload: { repoId, id: 'preset-1', name: 'Mobile', directories: ['mobile'] },
      client: { sendRequest } as unknown as RpcClient,
      authority: workspaceAuthority
    })

    expect(listed).toMatchObject({ presets: [{ repoId, id: 'preset-1' }] })
    expect(saved).toMatchObject({ preset: { repoId, id: 'preset-1' } })
    expect(sendRequest).toHaveBeenCalledWith('repo.sparsePresets', { repo: 'id:host-repo' })
    expect(sendRequest).toHaveBeenCalledWith('repo.saveSparsePreset', {
      repo: 'id:host-repo',
      id: 'preset-1',
      name: 'Mobile',
      directories: ['mobile']
    })
    expect(JSON.stringify([listed, saved])).not.toContain('host-repo')
  })
})
