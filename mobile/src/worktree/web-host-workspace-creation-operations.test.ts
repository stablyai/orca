import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostWorkspaceCreationOperations } from './web-host-workspace-creation-operations'

describe('web host workspace creation operations', () => {
  it('forwards the catalog reads the native app makes, unprojected', async () => {
    const client = bridgeClient()
    const operations = webHostWorkspaceCreationOperations(
      client as unknown as MobileWebBridgeClient
    )

    await expect(operations.listRepositories()).resolves.toEqual([
      {
        id: 'repo-1',
        displayName: 'Orca',
        connectionId: 'connection-1',
        executionHostId: 'ssh:host-1',
        kind: 'git',
        path: '/workspace/orca'
      }
    ])
    await expect(operations.readRuntimeSettings()).resolves.toEqual({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: ['claude', 'unknown-agent'],
      visibleTaskProviders: ['github']
    })
    expect(client.hostRpcSender.sendRequest).toHaveBeenCalledWith('repo.list')
    expect(client.hostRpcSender.sendRequest).toHaveBeenCalledWith('settings.get')
  })

  it('sends only a named agent choice and strips page-visible fork remote URLs', async () => {
    const client = bridgeClient()
    const operations = webHostWorkspaceCreationOperations(
      client as unknown as MobileWebBridgeClient
    )

    await expect(
      operations.createWorkspaceFromSource({
        selection: {
          kind: 'work-item',
          item: {
            provider: 'github',
            type: 'pr',
            number: 7,
            title: 'Seven',
            url: 'https://github.example.com/acme/orca/pull/7',
            repoId: 'repo-page-1'
          },
          baseBranch: 'refs/pull/7/head',
          pushTarget: {
            remoteName: 'contributor',
            branchName: 'feature',
            remoteUrl: 'git@github.example.com:contributor/private.git'
          }
        },
        targetRepoId: 'repo-page-1',
        setupDecision: 'skip',
        agentChoice: 'codex',
        workspaceName: undefined,
        note: undefined,
        sparseCheckout: {
          directories: ['src/renderer'],
          presetId: 'renderer'
        },
        worktreeCreateIdempotency: false
      })
    ).resolves.toEqual({
      worktreeId: 'workspace-page-1',
      name: 'pr-7',
      warning: 'Setup completed with a warning.'
    })

    expect(client.workspaceCreationCreate.createFromSource).toHaveBeenCalledWith({
      selection: {
        kind: 'work-item',
        item: {
          provider: 'github',
          type: 'pr',
          number: 7,
          title: 'Seven',
          url: 'https://github.example.com/acme/orca/pull/7',
          repoId: 'repo-page-1'
        },
        baseBranch: 'refs/pull/7/head',
        pushTarget: { remoteName: 'contributor', branchName: 'feature' }
      },
      targetRepoId: 'repo-page-1',
      setupDecision: 'skip',
      agentChoice: 'codex',
      workspaceName: undefined,
      note: undefined,
      sparseCheckout: {
        directories: ['src/renderer'],
        presetId: 'renderer'
      },
      nameIsAutoManaged: undefined
    })
    expect(JSON.stringify(client.workspaceCreationCreate.createFromSource.mock.calls)).not.toMatch(
      /remoteUrl|private|supportsIdempotent/
    )
  })

  it('preserves the selected base branch when creating from a Linear issue', async () => {
    const client = bridgeClient()
    const operations = webHostWorkspaceCreationOperations(
      client as unknown as MobileWebBridgeClient
    )
    await operations.createWorkspaceFromSource({
      selection: {
        kind: 'work-item',
        item: {
          provider: 'linear',
          type: 'issue',
          number: 0,
          title: 'Release fix',
          url: 'https://linear.app/orca/issue/ORC-1',
          linearIdentifier: 'ORC-1'
        },
        baseBranch: 'origin/release'
      },
      targetRepoId: 'repo-1',
      setupDecision: 'skip',
      agentChoice: 'blank',
      workspaceName: undefined,
      note: undefined,
      worktreeCreateIdempotency: false
    })
    expect(client.workspaceCreationCreate.createFromSource).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: expect.objectContaining({ baseBranch: 'origin/release' })
      })
    )
  })

  it('maps all create failures to stable page-safe copy', async () => {
    const client = bridgeClient()
    client.workspaceCreationCreate.createBlank.mockRejectedValue(
      new Error('/Users/private TOKEN=secret')
    )
    const operations = webHostWorkspaceCreationOperations(
      client as unknown as MobileWebBridgeClient
    )

    await expect(
      operations.createBlankWorkspace({
        repoId: 'repo-page-1',
        baseName: 'safe',
        agentChoice: 'blank',
        comment: undefined,
        setupDecision: 'skip',
        worktreeCreateIdempotency: { dedupeTtlMs: 30_000 }
      })
    ).resolves.toEqual({ error: 'Unable to create workspace. Try again.' })
  })

  it('preserves the native SSH GitHub remote state without exposing host details', async () => {
    const client = bridgeClient()
    client.sendRequest.mockResolvedValue({
      ok: false,
      error: { code: 'not_found', message: 'not_found' }
    })
    const operations = webHostWorkspaceCreationOperations(
      client as unknown as MobileWebBridgeClient
    )

    await expect(operations.searchGitHubItems('repo-1', '')).rejects.toThrow(
      'GitHub work items require a GitHub remote for SSH repositories'
    )
  })
})

function bridgeClient() {
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'repo.list') {
      return {
        ok: true,
        result: {
          repos: [
            {
              id: 'repo-1',
              displayName: 'Orca',
              connectionId: 'connection-1',
              executionHostId: 'ssh:host-1',
              path: '/workspace/orca',
              kind: 'git'
            }
          ]
        }
      }
    }
    if (method === 'settings.get') {
      return {
        ok: true,
        result: {
          settings: {
            defaultTuiAgent: 'codex',
            disabledTuiAgents: ['claude', 'unknown-agent'],
            visibleTaskProviders: ['github']
          }
        }
      }
    }
    return { ok: true, result: {} }
  })
  return {
    sendRequest,
    hostRpcSender: { sendRequest },
    workspaceCreationCreate: {
      createBlank: vi.fn().mockResolvedValue({
        workspaceId: 'workspace-page-1',
        name: 'safe'
      }),
      createFromSource: vi.fn().mockResolvedValue({
        workspaceId: 'workspace-page-1',
        name: 'pr-7',
        warning: 'Setup completed with a warning.'
      })
    }
  }
}
