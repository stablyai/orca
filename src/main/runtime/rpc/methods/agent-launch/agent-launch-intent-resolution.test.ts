import { describe, expect, it, vi } from 'vitest'
import type { AgentLaunchParams } from '../../../../../shared/rpc-contract/agent-launch/agent-launch-params'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { resolveUnlaunchedIntent } from './agent-launch-intent-resolution'

function resolveWithDisabled(disabledTuiAgents: string[], params: Partial<AgentLaunchParams>) {
  const showTerminalWorkspaceLaunchScope = vi.fn(async () => {
    throw new Error('workspace_resolved')
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolution reads only these members before the stubbed workspace lookup throws.
  const runtime = {
    requireStore: () => ({ getSettings: () => ({ disabledTuiAgents }) }),
    showTerminalWorkspaceLaunchScope
  } as unknown as OrcaRuntimeService
  const resolved = resolveUnlaunchedIntent(
    { agent: 'opencode', target: { kind: 'existing', worktree: 'id:wt' }, ...params },
    runtime,
    null
  )
  return { resolved, showTerminalWorkspaceLaunchScope }
}

describe('resolveUnlaunchedIntent', () => {
  it.each(['chat', 'terminal'] as const)(
    'refuses a disabled agent on the %s surface before resolving its workspace',
    async (surface) => {
      const { resolved, showTerminalWorkspaceLaunchScope } = resolveWithDisabled(['opencode'], {
        surface
      })
      await expect(resolved).rejects.toMatchObject({
        code: 'agent_unconfigured',
        message: 'Agent opencode is disabled. Choose an enabled agent.'
      })
      expect(showTerminalWorkspaceLaunchScope).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['an enabled agent', ['codex'], { surface: 'chat' as const }],
    [
      'a prompt for a terminal a disabled agent already runs',
      ['opencode'],
      { reuseTerminal: { handle: 'term-1' } }
    ]
  ])('resolves %s', async (_, disabled, params) => {
    const { resolved, showTerminalWorkspaceLaunchScope } = resolveWithDisabled(disabled, params)
    await expect(resolved).rejects.toThrow('workspace_resolved')
    expect(showTerminalWorkspaceLaunchScope).toHaveBeenCalledOnce()
  })
})
