import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExecutionHostNotDispatchableError } from '../../../providers/execution-host-provider-dispatch'
import { notifyAgentsRefreshedOnHost } from '../../../preflight/agents-refreshed-on-host'
import type { DiscoverCommitMessageModelsResult } from '../../../text-generation/source-control-text-generation-types'
import { discoverModelsForWorkspace, type RemoteModelProbe } from './workspace-model-discovery'

const PROVIDER_A = 'provider-a/claude-sonnet-5-5'
const PROVIDER_B = 'provider-b/claude-sonnet-5-5'

function claudeStdout(): string {
  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      response: {
        models: [
          {
            value: 'claude-sonnet-5-5',
            displayName: 'Sonnet 5.5',
            resolvedModel: 'claude-sonnet-5-5'
          },
          { value: PROVIDER_A, displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5' },
          { value: PROVIDER_B, displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5' }
        ]
      }
    }
  })
}

const listed: DiscoverCommitMessageModelsResult = {
  success: true,
  catalogOrigin: 'probe',
  defaultModelId: PROVIDER_B,
  models: [{ id: PROVIDER_B, label: 'Sonnet 5.5' }],
  capability: {
    id: 'claude',
    label: 'Claude',
    modelSource: 'dynamic',
    defaultModelId: PROVIDER_B,
    models: [{ id: PROVIDER_B, label: 'Sonnet 5.5' }]
  }
}

const ENTERPRISE_REFUSAL =
  'You cannot use --strict-mcp-config when an enterprise MCP config is present'

describe('discoverModelsForWorkspace', () => {
  beforeEach(() => {
    notifyAgentsRefreshedOnHost(false)
  })

  it('discovers models in a folder workspace on this machine, including WSL', async () => {
    const discoverLocal = vi.fn(async () => listed)
    const result = await discoverModelsForWorkspace(
      {
        agentId: 'claude',
        workspace: { path: '/notes', executionHostId: 'local', wslDistro: 'Ubuntu' },
        env: { PATH: '/bin' }
      },
      { discoverLocal }
    )
    expect(discoverLocal).toHaveBeenCalledWith('claude', { PATH: '/bin' }, undefined, {
      cwd: '/notes',
      wslDistro: 'Ubuntu'
    })
    expect(result).toBe(listed)
  })

  it('runs the Claude probe on an SSH workspace and keeps provider routes', async () => {
    const runRemoteProbe = vi.fn(async () => ({ stdout: claudeStdout(), stderr: '', code: 0 }))
    const result = await discoverModelsForWorkspace(
      {
        agentId: 'claude',
        workspace: { path: '/srv/app', executionHostId: 'ssh:box' }
      },
      { runRemoteProbe }
    )
    expect(runRemoteProbe).toHaveBeenCalledWith(
      'box',
      expect.stringContaining("'/srv/app'"),
      expect.any(String)
    )
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.catalogOrigin).toBe('probe')
      expect(result.models.map((model) => model.id)).toEqual(
        expect.arrayContaining([PROVIDER_A, PROVIDER_B])
      )
    }
  })

  it('retries an SSH Claude probe without --strict-mcp-config after an enterprise refusal', async () => {
    const commands: string[] = []
    const runRemoteProbe = vi.fn(async (_connectionId: string, command: string) => {
      commands.push(command)
      if (command.includes('--strict-mcp-config')) {
        return { stdout: '', stderr: ENTERPRISE_REFUSAL, code: 1 }
      }
      return { stdout: claudeStdout(), stderr: '', code: 0 }
    })
    const result = await discoverModelsForWorkspace(
      { agentId: 'claude', workspace: { path: '/srv/app', executionHostId: 'ssh:box' } },
      { runRemoteProbe }
    )
    expect(commands.some((command) => command.includes('--strict-mcp-config'))).toBe(true)
    expect(commands.some((command) => !command.includes('--strict-mcp-config'))).toBe(true)
    expect(result.success).toBe(true)
  })

  it('reuses a warm SSH probe and drops it when agents refresh or the call failed', async () => {
    const runRemoteProbe = vi.fn(async (): Promise<RemoteModelProbe> => ({
      stdout: claudeStdout(),
      stderr: '',
      code: 0
    }))
    const input = {
      agentId: 'claude' as const,
      workspace: { path: '/srv/app', executionHostId: 'ssh:box' as const },
      env: { CLAUDE_CONFIG_DIR: '/accounts/claude-a', ANTHROPIC_BASE_URL: 'https://a.example' }
    }
    await discoverModelsForWorkspace(input, { runRemoteProbe })
    await discoverModelsForWorkspace(input, { runRemoteProbe })
    expect(runRemoteProbe).toHaveBeenCalledTimes(1)

    await discoverModelsForWorkspace(
      {
        ...input,
        env: { CLAUDE_CONFIG_DIR: '/accounts/claude-a', ANTHROPIC_BASE_URL: 'https://b.example' }
      },
      { runRemoteProbe }
    )
    expect(runRemoteProbe).toHaveBeenCalledTimes(2)

    notifyAgentsRefreshedOnHost(true)
    runRemoteProbe.mockResolvedValueOnce({ error: 'ssh down' })
    await discoverModelsForWorkspace(input, { runRemoteProbe })
    await discoverModelsForWorkspace(input, { runRemoteProbe })
    expect(runRemoteProbe).toHaveBeenCalledTimes(4)
  })

  it('sends routing env to the SSH probe and refuses a runtime host', async () => {
    const runRemoteProbe = vi.fn(async () => ({ stdout: claudeStdout(), stderr: '', code: 0 }))
    await discoverModelsForWorkspace(
      {
        agentId: 'claude',
        workspace: { path: '/srv/app', executionHostId: 'ssh:box' },
        env: { ANTHROPIC_BASE_URL: 'https://provider.example' }
      },
      { runRemoteProbe }
    )
    expect(runRemoteProbe).toHaveBeenCalledWith(
      'box',
      expect.stringContaining('https://provider.example'),
      expect.any(String)
    )

    const discoverLocal = vi.fn()
    await expect(
      discoverModelsForWorkspace(
        {
          agentId: 'claude',
          workspace: { path: '/srv/app', executionHostId: 'runtime:env-1' }
        },
        { discoverLocal, runRemoteProbe }
      )
    ).rejects.toBeInstanceOf(ExecutionHostNotDispatchableError)
    expect(discoverLocal).not.toHaveBeenCalled()
  })
})
