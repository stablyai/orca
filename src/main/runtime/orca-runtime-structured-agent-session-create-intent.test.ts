import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { structuredAgentSessionCreateWorktreeTarget } from './structured-agent-session-create-worktree-target'

describe('structured agent-session create intent', () => {
  it('pins the selected Codex launch home after normal launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn(() => '/accounts/selected/home')
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: { codex: { CODEX_HOME: '/configured/home' } },
          nativeChatSessionOptions: {
            codex: {
              model: 'gpt-5.6-sol',
              valuesByModel: {
                'gpt-5.6-sol': { effort: 'medium', fastMode: true, personality: 'concise' }
              }
            }
          }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    const internal = runtime as unknown as {
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        executionHostId: string
        worktree: { id: string; repoId: string; path: string }
      }>
    }
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      executionHostId: 'local',
      worktree: { id: 'workspace-1', repoId: 'repo-1', path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'codex'
    })

    expect(prepareCodexStructuredLaunch).toHaveBeenCalledWith({
      workspacePath: '/repos/workspace-1',
      launchEnv: expect.objectContaining({ CODEX_HOME: '/configured/home' })
    })
    expect(intent.accountHome).toEqual({
      variable: 'CODEX_HOME',
      path: '/accounts/selected/home'
    })
    expect(intent.options).toEqual({ model: 'gpt-5.6-sol', effort: 'medium' })
    expect(internal.resolveRuntimeFileTarget).toHaveBeenCalledOnce()
  })

  it('pins the configured Claude launch home without Codex launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn()
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: {
            claude: { CLAUDE_CONFIG_DIR: '/configured/claude-home' }
          },
          nativeChatSessionOptions: {
            claude: {
              model: 'opus',
              valuesByModel: { opus: { effort: 'high', fastMode: true } }
            }
          }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    const internal = runtime as unknown as {
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        executionHostId: string
        worktree: { id: string; repoId: string; path: string }
      }>
    }
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      executionHostId: 'local',
      worktree: { id: 'workspace-1', repoId: 'repo-1', path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'claude'
    })

    expect(prepareCodexStructuredLaunch).not.toHaveBeenCalled()
    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/configured/claude-home'
    })
    expect(intent.options).toEqual({ model: 'opus', effort: 'high' })
  })

  it('uses the managed Claude launch home before falling back to ~/.claude', async () => {
    const prepareCodexStructuredLaunch = vi.fn()
    const getRuntimeConfigDir = vi.fn(() => '/accounts/managed/claude-home')
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: { claude: {} }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    runtime.setAccountServices({
      claudeAccounts: { getRuntimeConfigDir } as never,
      codexAccounts: {} as never,
      rateLimits: {} as never
    })
    const internal = runtime as unknown as {
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        executionHostId: string
        worktree: { id: string; repoId: string; path: string }
      }>
    }
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      executionHostId: 'local',
      worktree: { id: 'workspace-1', repoId: 'repo-1', path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'claude'
    })

    expect(getRuntimeConfigDir).toHaveBeenCalledTimes(1)
    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/accounts/managed/claude-home'
    })
  })

  it('rejects a resolved checkout that differs from the authorized occupant', async () => {
    const runtime = new OrcaRuntimeService({ getSettings: () => ({}) } as never)
    const internal = runtime as unknown as {
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        executionHostId: string
        worktree: {
          id: string
          repoId: string
          path: string
          instanceId: string
          creatorProvenance: { kind: string; deviceId: string }
        }
      }>
    }
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      executionHostId: 'local',
      worktree: {
        id: 'workspace-2',
        repoId: 'repo-1',
        path: '/repos/workspace-2',
        instanceId: 'instance-2',
        creatorProvenance: { kind: 'paired-device', deviceId: 'device-other' }
      }
    }))
    const expectedWorktreeTarget = structuredAgentSessionCreateWorktreeTarget({
      id: 'workspace-1',
      repoId: 'repo-1',
      path: '/repos/workspace-1',
      instanceId: 'instance-1',
      creatorProvenance: { kind: 'paired-device', deviceId: 'device-owner' }
    } as never)

    await expect(
      runtime.resolveStructuredAgentSessionCreateIntent({
        envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
        worktree: 'name:changing-alias',
        agent: 'codex',
        expectedWorktreeTarget
      })
    ).rejects.toThrow('structured_agent_session_unsupported')
    expect(internal.resolveRuntimeFileTarget).toHaveBeenCalledOnce()
  })
})
