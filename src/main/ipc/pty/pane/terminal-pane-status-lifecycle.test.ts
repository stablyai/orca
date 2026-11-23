import { afterEach, expect, it, vi } from 'vitest'
import type { AgentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { bindTerminalPaneStatusLifecycle } from './terminal-pane-status-lifecycle'

const { setTerminalPaneLifecycle, getProviderForPty, confirmRootShellAlone } = vi.hoisted(() => ({
  setTerminalPaneLifecycle: vi.fn<AgentHookServer['setTerminalPaneLifecycle']>(),
  getProviderForPty: vi.fn(),
  confirmRootShellAlone: vi.fn()
}))
vi.mock('../../../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: { setTerminalPaneLifecycle, pruneUnplacedSleepingPanes: () => {} }
}))
vi.mock('../provider/registry', () => ({ getProviderForPty }))
vi.mock('../../../memory/pty-registry', () => ({
  getRegisteredPtyPid: (ptyId: string) => (ptyId === 'pty-1' ? 4242 : null)
}))
vi.mock('../../../runtime/terminal/lifecycle/run-terminal-shell-alone', () => ({
  confirmRootShellAloneFromProcessTable: confirmRootShellAlone,
  paneAgentProcess: () => () => true
}))

const platform = process.platform
afterEach(() => Object.defineProperty(process, 'platform', { value: platform }))

it.each([
  [
    'shell alone after the launched agent quit',
    'darwin',
    true,
    'zsh',
    undefined,
    'held',
    false,
    true
  ],
  [
    'shell alone after a reattach left the launch unknown',
    'darwin',
    true,
    'zsh',
    undefined,
    'unknown',
    false,
    true
  ],
  [
    'no shell-alone proof (stopped job, agent foreground)',
    'darwin',
    false,
    'zsh',
    'no-children',
    'held',
    false,
    false
  ],
  [
    'a typed agent with no launch held, its shell alone',
    'darwin',
    true,
    'zsh',
    undefined,
    'gone',
    false,
    true
  ],
  ['successor launch during inspection', 'darwin', true, 'zsh', undefined, 'held', true, false],
  [
    'unmarked cmd.exe back alone in its job on Windows',
    'win32',
    false,
    'cmd.exe',
    'no-children',
    'held',
    false,
    true
  ],
  [
    'unnamed agent still in the job on Windows',
    'win32',
    false,
    'cmd.exe',
    'children',
    'held',
    false,
    false
  ],
  [
    'older daemon without a child census on Windows',
    'win32',
    false,
    'cmd.exe',
    undefined,
    'held',
    false,
    false
  ]
] as const)(
  'proves an unmarked process exit only for the current launch: %s',
  async (_, os, shellAlone, foreground, census, evidence, replaced, expected) => {
    Object.defineProperty(process, 'platform', { value: os })
    const launch = { agentArgs: '', agentEnv: {} }
    let currentLaunch = evidence === 'held' ? launch : evidence === 'gone' ? null : undefined
    const proveShellAlone = async () => {
      if (replaced) {
        currentLaunch = { agentArgs: '--resume next', agentEnv: {} }
      }
      return shellAlone
    }
    // POSIX reads the PTY's root shell from the process table, whatever the provider says.
    confirmRootShellAlone.mockImplementation(async (rootPid: number) =>
      rootPid === 4242 ? proveShellAlone() : false
    )
    getProviderForPty.mockReturnValue({
      confirmShellForeground: os === 'win32' ? proveShellAlone : async () => true,
      // Windows answers from its job census; a foreground name alone is not that census.
      inspectProcess: async () => ({
        foregroundProcess: foreground,
        hasChildProcesses: false,
        ...(census ? { childProcessEvidence: census } : {})
      })
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this exit probe only reads these two runtime capabilities.
    const runtime = {
      resolveTerminalPane: () => ({ ptyId: 'pty-1', incarnationId: 'birth-1' }),
      terminalRunFacts: { readLastInputAt: () => null },
      getLaunchStatementForPty: () => currentLaunch
    } as unknown as OrcaRuntimeService
    bindTerminalPaneStatusLifecycle(runtime, undefined)
    const lifecycle = setTerminalPaneLifecycle.mock.lastCall![0]
    expect(
      await lifecycle.confirmProcessExit?.('tab:11111111-1111-4111-8111-111111111111', 'codex')
    ).toBe(expected)
  }
)

it('does not count a shell-alone proof once input reached the PTY while it ran', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  let typed = false
  let lastInputAt = 1
  // The user sends `codex resume <id>` (desktop, CLI or mobile) after the table was read but
  // before the proof returns; a terminal's automatic query reply is not recorded as input.
  confirmRootShellAlone.mockImplementation(async () => {
    if (typed) {
      lastInputAt += 1
    }
    return true
  })
  getProviderForPty.mockReturnValue({})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the proof only resolves the pane and reads its input facts.
  const runtime = {
    resolveTerminalPane: () => ({ ptyId: 'pty-1', incarnationId: 'birth-1' }),
    terminalRunFacts: { readLastInputAt: () => lastInputAt }
  } as unknown as OrcaRuntimeService
  bindTerminalPaneStatusLifecycle(runtime, undefined)
  const lifecycle = setTerminalPaneLifecycle.mock.lastCall![0]
  const paneKey = 'tab:11111111-1111-4111-8111-111111111111'
  expect(await lifecycle.confirmShellAlone?.(paneKey, 'codex')).toBe(true)
  typed = true
  expect(await lifecycle.confirmShellAlone?.(paneKey, 'codex')).toBe(false)
})
