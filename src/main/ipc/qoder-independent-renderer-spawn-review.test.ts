import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { createDaemonActiveProviderFixtures } from './pty-ipc-daemon-provider-fixtures'
import { registerPtyHandlers } from './pty'
import { detectAgentCommandsOnHost } from '../preflight/agent-detection'
import { buildAgentStartupPlan, buildAgentResumeStartupPlan } from '../../shared/tui-agent-startup'
import { agentStartedTelemetry } from '../agent-launch/agent-started-telemetry'
import { trackMock } from './pty-ipc-mock-registry'

vi.mock('../preflight/agent-detection', () => ({
  detectAgentCommandsOnHost: vi.fn(async () => new Set(['qoder']))
}))
vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('independent renderer Qoder provider spawn boundary', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()
  const { setupDaemonAdapter } = createDaemonActiveProviderFixtures({ handlers, mainWindow })
  it.each(['start', 'resume'] as const)(
    'selects modern-only executable for desktop %s',
    async (mode) => {
      const plan =
        mode === 'start'
          ? buildAgentStartupPlan({
              agent: 'qoder',
              prompt: 'review prompt',
              agentArgs: null,
              cmdOverrides: {},
              platform: 'darwin'
            })
          : buildAgentResumeStartupPlan({
              agent: 'qoder',
              providerSession: { key: 'session_id', id: 'original-review-session' },
              cmdOverrides: {},
              platform: 'darwin'
            })
      if (!plan) {
        throw new Error('Missing existing Qoder startup plan')
      }
      const physicalSpawn = setupDaemonAdapter()
      registerPtyHandlers(mainWindow)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        command: plan.launchCommand,
        launchAgent: 'qoder',
        launchConfig: plan.launchConfig,
        ...(mode === 'start' ? { telemetry: agentStartedTelemetry('qoder', 'orchestration') } : {})
      })
      expect(physicalSpawn.mock.calls.at(-1)?.[0].command).toBe(
        plan.launchCommand.replace(/^qodercli/, 'qoder')
      )
      expect(detectAgentCommandsOnHost).toHaveBeenCalled()
      const events = trackMock.mock.calls.filter(([event]) => event === 'agent_started')
      if (mode === 'start') {
        expect(events).toEqual([
          [
            'agent_started',
            { agent_kind: 'qoder', launch_source: 'orchestration', request_kind: 'new' }
          ]
        ])
      } else {
        expect(events).toEqual([])
      }
    }
  )
  it.each([
    'qoder --resume original-review-session',
    '/caller/qodercli --resume original-review-session'
  ])('preserves an explicitly chosen command: %s', async (command) => {
    const physicalSpawn = setupDaemonAdapter()
    registerPtyHandlers(mainWindow)
    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      command,
      launchAgent: 'qoder'
    })
    expect(physicalSpawn.mock.calls.at(-1)?.[0].command).toBe(command)
    expect(trackMock).not.toHaveBeenCalledWith('agent_started', expect.anything())
  })
})
