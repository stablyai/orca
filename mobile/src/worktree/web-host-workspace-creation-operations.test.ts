import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { MobileWebBridgeClientError } from '../../../src/mobile-web/src/mobile-web-bridge-client-error'
import { webHostWorkspaceCreationOperations } from './web-host-workspace-creation-operations'

describe('web host workspace creation operations', () => {
  it('rebuilds bounded mobile view models with opaque hosted authority', async () => {
    const client = bridgeClient()
    const operations = webHostWorkspaceCreationOperations(
      client as unknown as MobileWebBridgeClient
    )

    await expect(operations.listRepositories()).resolves.toEqual([
      {
        id: 'repo-page-1',
        displayName: 'Orca',
        connectionId: 'repo-page-1',
        executionHostId: 'ssh:executionHost-page-1',
        executionHostLabel: 'Host',
        projectId: 'project-page-1',
        kind: 'git',
        path: '/workspace/orca'
      }
    ])
    await expect(operations.readRuntimeSettings()).resolves.toEqual({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: ['claude'],
      visibleTaskProviders: ['github']
    })
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
    client.workspaceCreationSource.searchGitHub.mockRejectedValue(
      new MobileWebBridgeClientError('not_found', false)
    )
    const operations = webHostWorkspaceCreationOperations(
      client as unknown as MobileWebBridgeClient
    )

    await expect(operations.searchGitHubItems('repo-page-1', '')).rejects.toThrow(
      'GitHub work items require a GitHub remote for SSH repositories'
    )
  })
})

function bridgeClient() {
  return {
    workspaceCreation: {
      repositories: vi.fn().mockResolvedValue({
        repositories: [
          {
            id: 'repo-page-1',
            displayName: 'Orca',
            connectionId: 'repo-page-1',
            executionHostId: 'ssh:executionHost-page-1',
            executionHostLabel: 'Host',
            projectId: 'project-page-1',
            path: '/workspace/orca',
            kind: 'git'
          }
        ]
      }),
      settings: vi.fn().mockResolvedValue({
        defaultTuiAgent: 'codex',
        disabledTuiAgents: ['claude', 'unknown-agent'],
        visibleTaskProviders: ['github']
      })
    },
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
    },
    workspaceCreationSource: {
      searchGitHub: vi.fn().mockResolvedValue([])
    }
  }
}
