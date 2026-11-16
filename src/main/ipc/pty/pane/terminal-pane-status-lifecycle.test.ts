import { afterEach, expect, it, vi } from 'vitest'
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

const platform = process.platform
afterEach(() => Object.defineProperty(process, 'platform', { value: platform }))

it.each([
  ['shell alone after the launched agent quit', 'darwin', true, 'zsh', 'held', false, true],
  [
    'shell alone after a reattach left the launch unknown',
    'darwin',
    true,
    'zsh',
    'unknown',
    false,
    true
  ],
  [
    'no shell-alone proof (stopped job, agent foreground)',
    'darwin',
    false,
    'zsh',
    'held',
    false,
    false
  ],
  ['intervening command retired the launch', 'darwin', true, 'zsh', 'gone', false, false],
  ['successor launch during inspection', 'darwin', true, 'zsh', 'held', true, false],
  ['unmarked cmd.exe back alone on Windows', 'win32', false, 'cmd.exe', 'held', false, true],
  ['agent still foreground on Windows', 'win32', false, 'codex.exe', 'held', false, false]
] as const)(
  'proves an unmarked process exit only for the current launch: %s',
  async (_, os, shellAlone, foreground, evidence, replaced, expected) => {
    Object.defineProperty(process, 'platform', { value: os })
    const launch = { agentArgs: '', agentEnv: {} }
    let currentLaunch = evidence === 'held' ? launch : evidence === 'gone' ? null : undefined
    getProviderForPty.mockReturnValue({
      confirmShellForeground: async () => {
        if (replaced) {
          currentLaunch = { agentArgs: '--resume next', agentEnv: {} }
        }
        return shellAlone
      },
      // Windows answers from its job census; a scan that names no agent is not that census.
      inspectProcess: async () => ({
        foregroundProcess: foreground,
        hasChildProcesses: foreground !== 'cmd.exe',
        childProcessEvidence: foreground === 'cmd.exe' ? 'no-children' : 'children'
      })
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
