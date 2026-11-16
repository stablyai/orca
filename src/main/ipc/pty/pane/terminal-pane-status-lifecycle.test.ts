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
  ['quit at cmd', false, 'cmd.exe', true, false, true],
  ['quit at Git Bash', false, 'bash', true, false, true],
  ['stopped child', true, 'bash', true, false, false],
  ['agent foreground', false, 'codex', true, false, false],
  ['unanswered shell', false, null, true, false, false],
  ['intervening command revoked launch', false, 'bash', false, false, false],
  ['successor launch during inspection', false, 'cmd.exe', true, true, false]
] as const)(
  'proves an unmarked process exit only for the current launch: %s',
  async (_, children, foreground, held, replaced, expected) => {
    const launch = { agentArgs: '', agentEnv: {} }
    let currentLaunch = held ? launch : null
    getProviderForPty.mockReturnValue({
      hasChildProcesses: async () => children,
      confirmForegroundProcess: async () => {
        if (replaced) {
          currentLaunch = { agentArgs: '--resume next', agentEnv: {} }
        }
        return foreground
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
