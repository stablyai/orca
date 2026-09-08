import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { nativeHostWorkspaceCreationOperations } from './native-host-workspace-creation-operations'

describe('native host workspace creation operations', () => {
  it('maps named repository and environment reads to existing RPC authority', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce({
        ok: true,
        result: { repos: [{ id: 'repo-1', path: '/host/repo' }] }
      })
      .mockResolvedValueOnce({ ok: true, result: { settings: { defaultTuiAgent: 'codex' } } })
      .mockResolvedValueOnce({
        ok: true,
        result: { ui: { trustedOrcaHooks: { 'repo-1': { all: { approvedAt: 10 } } } } }
      })
      .mockResolvedValueOnce({ ok: true, result: { glab: { installed: true } } })
      .mockResolvedValueOnce({ ok: true, result: { connected: true } })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          state: {
            targetId: 'ssh-1',
            status: 'connected',
            error: null,
            reconnectAttempt: 0
          }
        }
      })
      .mockResolvedValueOnce({ ok: true, result: ['codex', 'claude'] })
      .mockResolvedValueOnce({
        ok: true,
        result: { hooks: { scripts: { setup: 'pnpm install' } }, source: '/host/orca.yaml' }
      })
    const operations = nativeHostWorkspaceCreationOperations({
      sendRequest
    } as unknown as RpcClient)

    await expect(operations.listRepositories()).resolves.toEqual([
      { id: 'repo-1', path: '/host/repo' }
    ])
    await expect(operations.readRuntimeSettings()).resolves.toEqual({
      defaultTuiAgent: 'codex'
    })
    await expect(operations.readTrustedHooks()).resolves.toEqual({
      'repo-1': { all: { approvedAt: 10 } }
    })
    await expect(operations.isGitLabCliInstalled()).resolves.toBe(true)
    await expect(operations.isLinearConnected()).resolves.toBe(true)
    await expect(operations.readSshState('ssh-1')).resolves.toMatchObject({
      targetId: 'ssh-1',
      status: 'connected'
    })
    await expect(operations.detectAgents('ssh-1')).resolves.toEqual(['codex', 'claude'])
    await expect(operations.readRepoHooks('repo-1')).resolves.toMatchObject({
      hooks: { scripts: { setup: 'pnpm install' } }
    })

    expect(sendRequest.mock.calls).toEqual([
      ['repo.list'],
      ['settings.get'],
      ['ui.get'],
      ['preflight.check'],
      ['linear.status'],
      ['ssh.getState', { targetId: 'ssh-1' }],
      ['preflight.detectRemoteAgents', { connectionId: 'ssh-1' }],
      ['repo.hooks', { repo: 'id:repo-1' }]
    ])
  })

  it('preserves provider and SSH execution ownership behind named source operations', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce({
        ok: true,
        result: { owner: 'acme', repo: 'orca', host: 'github.example.com' }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          id: 'item-7',
          type: 'pr',
          number: 7,
          title: 'Seven',
          state: 'open',
          url: 'https://github.example.com/acme/orca/pull/7',
          labels: [],
          updatedAt: '2026-07-23T00:00:00Z',
          author: null
        }
      })
      .mockResolvedValueOnce({ ok: true, result: {} })
    const operations = nativeHostWorkspaceCreationOperations({
      sendRequest
    } as unknown as RpcClient)

    await expect(operations.resolveGitHubRepoSlug('repo-1')).resolves.toEqual({
      supported: true,
      slug: { owner: 'acme', repo: 'orca', host: 'github.example.com' }
    })
    await expect(
      operations.lookupGitHubItemByOwnerRepo({
        repoId: 'repo-1',
        slug: { owner: 'acme', repo: 'orca', host: 'github.example.com' },
        number: 7,
        type: 'pr'
      })
    ).resolves.toMatchObject({ repoId: 'repo-1', number: 7 })
    await operations.persistSetupTrust({
      trust: {},
      repoId: 'repo-1',
      contentHash: 'a'.repeat(64),
      alwaysTrust: false
    })

    expect(sendRequest.mock.calls).toEqual([
      ['github.repoSlug', { repo: 'id:repo-1' }],
      [
        'github.workItemByOwnerRepo',
        {
          repo: 'id:repo-1',
          owner: 'acme',
          ownerRepo: 'orca',
          host: 'github.example.com',
          number: 7,
          type: 'pr'
        }
      ],
      [
        'ui.set',
        {
          trustedOrcaHooks: {
            'repo-1': {
              setup: { contentHash: 'a'.repeat(64), approvedAt: expect.any(Number) }
            }
          }
        }
      ]
    ])
  })
})
