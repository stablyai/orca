import { beforeEach, describe, expect, it, vi } from 'vitest'

const discoverModelsForWorkspace = vi.hoisted(() => vi.fn())

vi.mock('./workspace-model-discovery', () => ({
  discoverModelsForWorkspace
}))

import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { RuntimeGitGenerationCommands } from './runtime-git-generation-commands'
import type { RuntimeGitCommandHost } from './runtime-git-command-target'

const listed = {
  success: true as const,
  catalogOrigin: 'probe' as const,
  defaultModelId: 'provider-b/claude-sonnet-5-5',
  models: [{ id: 'provider-b/claude-sonnet-5-5', label: 'Sonnet 5.5' }],
  capability: {
    id: 'claude' as const,
    label: 'Claude',
    modelSource: 'dynamic' as const,
    defaultModelId: 'provider-b/claude-sonnet-5-5',
    models: [{ id: 'provider-b/claude-sonnet-5-5', label: 'Sonnet 5.5' }]
  }
}

function host(workspace: {
  path: string
  executionHostId: ExecutionHostId
  wslDistro?: string
}): RuntimeGitCommandHost {
  return {
    resolveRuntimeGitTarget: async () => {
      throw new Error('not a git worktree')
    },
    resolveModelDiscoveryWorkspace: async () => workspace,
    getRuntimeSettings: () => ({})
  }
}

describe('discoverRuntimeCommitMessageModels', () => {
  beforeEach(() => {
    discoverModelsForWorkspace.mockReset()
    discoverModelsForWorkspace.mockResolvedValue(listed)
  })

  it('discovers Claude models for a folder workspace instead of requiring a git worktree', async () => {
    const commands = new RuntimeGitGenerationCommands(
      host({ path: '/notes', executionHostId: 'local' })
    )
    const result = await commands.discoverRuntimeCommitMessageModels('id:folder:notes', 'claude')
    expect(result).toEqual(listed)
    expect(discoverModelsForWorkspace).toHaveBeenCalledWith({
      agentId: 'claude',
      workspace: { path: '/notes', executionHostId: 'local' },
      env: expect.any(Object),
      launchEnv: {},
      agentCommandOverride: undefined
    })
  })

  it('discovers Claude models on an SSH workspace instead of reporting no git provider', async () => {
    const commands = new RuntimeGitGenerationCommands(
      host({ path: '/srv/app', executionHostId: 'ssh:box' })
    )
    const result = await commands.discoverRuntimeCommitMessageModels('id:repo::/srv/app', 'claude')
    expect(result).toEqual(listed)
    expect(discoverModelsForWorkspace).toHaveBeenCalledWith({
      agentId: 'claude',
      workspace: { path: '/srv/app', executionHostId: 'ssh:box' },
      env: undefined,
      launchEnv: {},
      agentCommandOverride: undefined
    })
  })

  it('passes providers configured in agentDefaultEnv to local and SSH discovery', async () => {
    const provider = { claude: { ANTHROPIC_BASE_URL: 'https://provider.example' } }
    const settings = { agentDefaultEnv: provider }
    const local = new RuntimeGitGenerationCommands({
      ...host({ path: '/notes', executionHostId: 'local' }),
      getRuntimeSettings: () => settings
    })
    await local.discoverRuntimeCommitMessageModels('id:folder:notes', 'claude')
    expect(discoverModelsForWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ ANTHROPIC_BASE_URL: 'https://provider.example' }),
        launchEnv: provider.claude
      })
    )

    discoverModelsForWorkspace.mockClear()
    const remote = new RuntimeGitGenerationCommands({
      ...host({ path: '/srv/app', executionHostId: 'ssh:box' }),
      getRuntimeSettings: () => settings
    })
    await remote.discoverRuntimeCommitMessageModels('id:repo::/srv/app', 'claude')
    expect(discoverModelsForWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        env: provider.claude,
        launchEnv: provider.claude
      })
    )
  })

  it('lets agentDefaultEnv beat the login shell and keeps the account config dir', async () => {
    const commands = new RuntimeGitGenerationCommands({
      ...host({ path: '/notes', executionHostId: 'local' }),
      getRuntimeSettings: () => ({
        agentDefaultEnv: { claude: { ANTHROPIC_BASE_URL: 'https://agent-default.example' } }
      }),
      getCommitMessageAgentEnvironment: () => ({
        resolveBaseEnvironment: async () => ({
          ANTHROPIC_BASE_URL: 'https://login-shell.example',
          PATH: '/usr/bin'
        }),
        prepareForClaudeLaunch: async () => ({
          configDir: '/accounts/work',
          envPatch: { CLAUDE_CONFIG_DIR: '/accounts/work' },
          provenance: 'test'
        })
      })
    })
    await commands.discoverRuntimeCommitMessageModels('id:folder:notes', 'claude')
    expect(discoverModelsForWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          ANTHROPIC_BASE_URL: 'https://agent-default.example',
          CLAUDE_CONFIG_DIR: '/accounts/work'
        }),
        accountPatch: { CLAUDE_CONFIG_DIR: '/accounts/work' }
      })
    )
    const passed = discoverModelsForWorkspace.mock.calls[0]?.[0]
    expect(passed?.env?.ANTHROPIC_BASE_URL).not.toBe('https://login-shell.example')
  })
})
