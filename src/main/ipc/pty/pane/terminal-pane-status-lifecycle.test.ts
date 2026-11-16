import { expect, it, vi } from 'vitest'
import type { AgentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { bindTerminalPaneStatusLifecycle } from './terminal-pane-status-lifecycle'

const { setTerminalPaneLifecycle, getProviderForPty } = vi.hoisted(() => ({
  setTerminalPaneLifecycle: vi.fn<AgentHookServer['setTerminalPaneLifecycle']>(),
  getProviderForPty: vi.fn()
}))
vi.mock('../../../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: { setTerminalPaneLifecycle, pruneUnplacedSleepingPanes: () => {} }
}))
vi.mock('../provider/registry', () => ({ getProviderForPty }))

it.each([
  ['shell alone after the launched agent quit', true, 'held', false, true],
  ['shell alone after a reattach left the launch unknown', true, 'unknown', false, true],
  ['no shell-alone proof (stopped job, agent foreground, unanswered)', false, 'held', false, false],
  ['intervening command retired the launch', true, 'gone', false, false],
  ['successor launch during inspection', true, 'held', true, false]
] as const)(
  'proves an unmarked process exit only for the current launch: %s',
  async (_, shellAlone, evidence, replaced, expected) => {
    const launch = { agentArgs: '', agentEnv: {} }
    let currentLaunch = evidence === 'held' ? launch : evidence === 'gone' ? null : undefined
    getProviderForPty.mockReturnValue({
      confirmShellForeground: async () => {
        if (replaced) {
          currentLaunch = { agentArgs: '--resume next', agentEnv: {} }
        }
        return shellAlone
      }
    })
    // SAFETY: This binding's exit probe only reads these two runtime capabilities.
    const runtime = {
      resolveTerminalPane: () => ({ ptyId: 'pty-1', incarnationId: 'birth-1' }),
      getLaunchStatementForPaneKey: () => currentLaunch
    } as unknown as OrcaRuntimeService
    bindTerminalPaneStatusLifecycle(runtime, undefined)
    const lifecycle = setTerminalPaneLifecycle.mock.lastCall![0]
    expect(
      await lifecycle.confirmProcessExit?.('tab:11111111-1111-4111-8111-111111111111', 'codex')
    ).toBe(expected)
  }
)
