import { homedir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { MISSION_METHODS } from './mission'
import { generateTextFromPrompt } from '../../../text-generation/commit-message-text-generation'

vi.mock('../../../text-generation/commit-message-text-generation', () => ({
  generateTextFromPrompt: vi.fn()
}))

const method = MISSION_METHODS.find((candidate) => candidate.name === 'mission.plan')!

describe('mission.plan', () => {
  let runtime: OrcaRuntimeService

  function setup(): void {
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
      'mission-plan'
    )
  })

  it('uses the configured default agent when --agent is omitted', async () => {
    setup()
    vi.mocked(generateTextFromPrompt).mockResolvedValue({
      success: true,
      text: '{"mode":"single-agent"}',
      agentLabel: 'Pi'
    })

    await expect(
      call({ text: 'Inspect this task.', worktree: 'id:repo::worktree' })
    ).resolves.toMatchObject({ agent: 'pi', plan: { mode: 'single-agent' } })
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

  it('surfaces invalid planner output as mission_planner_failed', async () => {
    setup()
    vi.mocked(generateTextFromPrompt).mockResolvedValue({
      success: true,
      text: 'not json',
      agentLabel: 'Pi'
    })

    await expect(
      call({ text: 'Inspect this task.', worktree: 'id:repo::worktree', agent: 'pi' })
    ).rejects.toMatchObject({ code: 'mission_planner_failed' })
  })
})
