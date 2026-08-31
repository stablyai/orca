import { homedir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { MISSION_METHODS } from './mission'
import { detectInstalledAgentsWithShellPathHydration } from '../../../ipc/preflight'
import { generateTextFromPrompt } from '../../../text-generation/commit-message-text-generation'

vi.mock('../../../ipc/preflight', () => ({
  detectInstalledAgentsWithShellPathHydration: vi.fn()
}))

vi.mock('../../../text-generation/commit-message-text-generation', () => ({
  generateTextFromPrompt: vi.fn()
}))

const method = MISSION_METHODS.find((candidate) => candidate.name === 'mission.plan')!

describe('mission.plan', () => {
  let runtime: OrcaRuntimeService

  function setup(): void {
    vi.mocked(generateTextFromPrompt).mockReset()
    vi.mocked(detectInstalledAgentsWithShellPathHydration).mockReset()
    vi.mocked(detectInstalledAgentsWithShellPathHydration).mockResolvedValue(['pi', 'codex'])
    runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
      worktreeVisibilityDefaults: { external: 'hide' },
      defaultTuiAgent: 'pi',
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      agentStatusHooksEnabled: true,
      defaultTaskSource: 'github',
      defaultTaskViewPreset: 'issues',
      visibleTaskProviders: ['github'],
      defaultRepoSelection: null,
      defaultLinearTeamSelection: null,
      githubProjects: undefined,
      experimentalNewWorktreeCardStyle: false,
      compactWorktreeCards: false,
      minimaxGroupId: undefined,
      minimaxUsageModels: undefined,
      prBotAuthorOverrides: undefined,
      artifactSharingEnabled: false,
      agentSkillSharingEnabled: false
    } as unknown as ReturnType<OrcaRuntimeService['getClientSettings']>)
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worktree',
      path: '/repo'
    } as Awaited<ReturnType<OrcaRuntimeService['showManagedTerminalWorkspace']>>)
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function call(params: Record<string, unknown>): Promise<unknown> {
    return method.handler(method.params!.parse(params), { runtime } as RpcContext)
  }

  it('plans with the selected agent and returns the parsed orchestration plan', async () => {
    setup()
    vi.mocked(generateTextFromPrompt).mockResolvedValue({
      success: true,
      text: JSON.stringify({
        mode: 'orchestration',
        objective: 'Parallel review',
        maxConcurrency: 2,
        tasks: [
          { key: 'a', spec: 'Inspect A', deps: [] },
          { key: 'b', spec: 'Inspect B', deps: [] }
        ]
      }),
      agentLabel: 'Pi'
    })

    const result = (await call({
      text: 'Use two agents to inspect A and B in parallel.',
      worktree: 'id:repo::worktree',
      agent: 'pi'
    })) as { mission: string; agent: string; plan: { mode: string; maxConcurrency?: number } }

    expect(result).toMatchObject({
      mission: 'Use two agents to inspect A and B in parallel.',
      agent: 'pi',
      plan: { mode: 'orchestration', maxConcurrency: 2 }
    })
    expect(generateTextFromPrompt).toHaveBeenCalledWith(
      expect.stringContaining('Return JSON only'),
      expect.objectContaining({
        agentId: 'pi',
        model: 'github-copilot/gpt-5.4-mini'
      }),
      { kind: 'local', cwd: homedir() },
      'mission-plan',
      { useAgentDefaultModel: true }
    )
  })

  it.each(['pi', 'omp'] as const)(
    'uses configured default %s planner for a single-agent plan when --agent is omitted',
    async (agent) => {
      setup()
      vi.mocked(runtime.getClientSettings).mockReturnValue({
        ...runtime.getClientSettings(),
        defaultTuiAgent: agent
      })
      vi.mocked(generateTextFromPrompt).mockResolvedValue({
        success: true,
        text: '{"mode":"single-agent"}',
        agentLabel: agent === 'omp' ? 'OMP' : 'Pi'
      })

      await expect(
        call({ text: 'Inspect this task.', worktree: 'id:repo::worktree' })
      ).resolves.toMatchObject({ agent, plan: { mode: 'single-agent' } })

      expect(vi.mocked(generateTextFromPrompt).mock.calls[0]?.[1].agentId).toBe(agent)
    }
  )

  it('plans separable work with the default OMP instead of silently choosing one worker', async () => {
    setup()
    vi.mocked(runtime.getClientSettings).mockReturnValue({
      ...runtime.getClientSettings(),
      defaultTuiAgent: 'omp'
    })
    vi.mocked(generateTextFromPrompt).mockResolvedValue({
      success: true,
      text: JSON.stringify({
        mode: 'orchestration',
        objective: 'Analyze independent performance bottlenecks',
        maxConcurrency: 2,
        tasks: [
          { key: 'compute', spec: 'Analyze CPU and memory observations.', deps: [] },
          { key: 'storage', spec: 'Analyze storage observations.', deps: [] }
        ]
      }),
      agentLabel: 'OMP'
    })

    await expect(
      call({ text: '分析当前电脑的性能缺口', worktree: 'id:repo::worktree' })
    ).resolves.toMatchObject({
      agent: 'omp',
      plan: {
        mode: 'orchestration',
        maxConcurrency: 2,
        tasks: [{ key: 'compute' }, { key: 'storage' }]
      }
    })
    expect(generateTextFromPrompt).toHaveBeenCalledWith(
      expect.stringContaining('分析当前电脑的性能缺口'),
      expect.objectContaining({ agentId: 'omp' }),
      { kind: 'local', cwd: homedir() },
      'mission-plan',
      { useAgentDefaultModel: true }
    )
  })

  it('surfaces an explicitly selected OMP planner failure instead of running the task unplanned', async () => {
    setup()
    vi.mocked(generateTextFromPrompt).mockResolvedValue({
      success: false,
      error: 'OMP planner unavailable.'
    })

    await expect(
      call({ text: 'Analyze performance.', worktree: 'id:repo::worktree', agent: 'omp' })
    ).rejects.toMatchObject({ code: 'mission_planner_failed' })
  })

  it.each(['pi', 'omp'] as const)(
    'falls back from unavailable default %s planner to the next detected agent',
    async (defaultAgent) => {
      setup()
      vi.mocked(runtime.getClientSettings).mockReturnValue({
        ...runtime.getClientSettings(),
        defaultTuiAgent: defaultAgent
      })
      vi.mocked(detectInstalledAgentsWithShellPathHydration).mockResolvedValue(['codex'])
      vi.mocked(generateTextFromPrompt)
        .mockResolvedValueOnce({ success: false, error: `${defaultAgent} planner unavailable.` })
        .mockResolvedValueOnce({
          success: true,
          text: '{"mode":"single-agent"}',
          agentLabel: 'Codex'
        })

      await expect(
        call({ text: 'Inspect this task.', worktree: 'id:repo::worktree' })
      ).resolves.toMatchObject({ agent: 'codex', plan: { mode: 'single-agent' } })

      expect(
        vi.mocked(generateTextFromPrompt).mock.calls.map(([, params]) => params.agentId)
      ).toEqual([defaultAgent, 'codex'])
    }
  )

  it('does not fall back when --agent explicitly selects an unavailable planner', async () => {
    setup()
    vi.mocked(generateTextFromPrompt).mockResolvedValue({
      success: false,
      error: 'Pi is not authenticated.'
    })

    await expect(
      call({ text: 'Inspect this task.', worktree: 'id:repo::worktree', agent: 'pi' })
    ).rejects.toMatchObject({ code: 'mission_planner_failed' })

    expect(generateTextFromPrompt).toHaveBeenCalledTimes(1)
    expect(vi.mocked(generateTextFromPrompt).mock.calls[0]?.[1].agentId).toBe('pi')
  })

  it('rejects a disabled explicit agent with a stable error code', async () => {
    setup()
    vi.mocked(runtime.getClientSettings).mockReturnValue({
      ...runtime.getClientSettings(),
      disabledTuiAgents: ['pi']
    })

    await expect(
      call({ text: 'Inspect this task.', worktree: 'id:repo::worktree', agent: 'pi' })
    ).rejects.toMatchObject({ code: 'agent_unconfigured' })
  })

  it.each([
    ['an ambiguous selector', new Error('selector_ambiguous')],
    ['a remote runtime failure', new Error('remote_runtime_unavailable')]
  ])('propagates %s from workspace resolution', async (_label, error) => {
    setup()
    vi.mocked(runtime.showManagedTerminalWorkspace).mockRejectedValue(error)

    await expect(
      call({ text: 'Inspect this task.', worktree: 'id:repo::worktree', agent: 'pi' })
    ).rejects.toBe(error)

    expect(generateTextFromPrompt).not.toHaveBeenCalled()
  })

  it('maps a missing managed workspace to a helpful mission error', async () => {
    setup()
    vi.mocked(runtime.showManagedTerminalWorkspace).mockRejectedValue(
      new Error('selector_not_found')
    )

    await expect(
      call({ text: 'Inspect this task.', worktree: 'id:repo::missing', agent: 'pi' })
    ).rejects.toMatchObject({
      code: 'selector_not_found',
      message: 'Mission requires an Orca-managed workspace.'
    })

    expect(generateTextFromPrompt).not.toHaveBeenCalled()
  })

  it.each(['pi', 'omp'] as const)(
    'repairs one malformed %s planner response before returning the parsed plan',
    async (agent) => {
      setup()
      vi.mocked(generateTextFromPrompt)
        .mockResolvedValueOnce({
          success: true,
          text: '{"mode":"single"}',
          agentLabel: agent === 'omp' ? 'OMP' : 'Pi'
        })
        .mockResolvedValueOnce({
          success: true,
          text: '{"mode":"single-agent"}',
          agentLabel: agent === 'omp' ? 'OMP' : 'Pi'
        })

      await expect(
        call({ text: 'Inspect this task.', worktree: 'id:repo::worktree', agent })
      ).resolves.toMatchObject({ agent, plan: { mode: 'single-agent' } })

      expect(
        vi.mocked(generateTextFromPrompt).mock.calls.map(([, params]) => params.agentId)
      ).toEqual([agent, agent])
      expect(vi.mocked(generateTextFromPrompt).mock.calls[1]?.[0]).toContain(
        'Repair the previous Mission Planner output'
      )
    }
  )

  it.each(['pi', 'omp'] as const)(
    'rejects persistently malformed %s planner output after one repair attempt',
    async (agent) => {
      setup()
      vi.mocked(generateTextFromPrompt).mockResolvedValue({
        success: true,
        text: 'not json',
        agentLabel: agent === 'omp' ? 'OMP' : 'Pi'
      })

      await expect(
        call({ text: 'Inspect this task.', worktree: 'id:repo::worktree', agent })
      ).rejects.toMatchObject({ code: 'mission_planner_failed' })

      expect(
        vi.mocked(generateTextFromPrompt).mock.calls.map(([, params]) => params.agentId)
      ).toEqual([agent, agent])
    }
  )
})
