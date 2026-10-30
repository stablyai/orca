import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as agentView from '../claude/agent-view-service'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import { setupPtyIpcSuite } from './pty/pty-ipc-test-harness'
import { createDaemonActiveProviderFixtures } from './pty/pty-ipc-daemon-provider-fixtures'

vi.mock('electron', () => import('./pty/pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty/pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty/pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty/pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty/pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty/pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe.each(['local', 'daemon'] as const)('%s PTY navigation readiness', (provider) => {
  const { handlers, mainWindow, spawnAndGetEnv } = setupPtyIpcSuite()
  const { daemonSpawnAndGetEnv } = createDaemonActiveProviderFixtures({ handlers, mainWindow })

  it.each([false, true])(
    'spawns a plain shell while reconciliation is pending (navigation: %s)',
    async (enabled) => {
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const config = join(tmpdir(), 'orca-spawn-pending-agent-view-config')
      vi.stubEnv('CLAUDE_CONFIG_DIR', config)
      const reconcileConfig = vi.fn(() => gate)
      const service = new agentView.ClaudeAgentViewService(
        join(tmpdir(), 'orca-spawn-pending-agent-view'),
        {
          reconcileConfig,
          ensurePlugin: async () => join(tmpdir(), 'orca-spawn-agent-view-plugin'),
          loginEnv: async () => ({ CLAUDE_CONFIG_DIR: config }),
          listProfiles: async () => []
        }
      )
      const settings = createGlobalSettingsFixture({ claudeSubagentNavigationEnabled: enabled })
      let reconciled = false
      const reconcile = service.reconcile(settings).then(() => {
        reconciled = true
      })
      await vi.waitFor(() => expect(reconcileConfig).toHaveBeenCalledOnce())
      const serviceSpy = vi.spyOn(agentView, 'getClaudeAgentViewService').mockReturnValue(service)
      let env: Record<string, string> | undefined
      const spawn = (
        provider === 'daemon'
          ? daemonSpawnAndGetEnv({}, undefined, () => settings)
          : spawnAndGetEnv({}, undefined, undefined, () => settings)
      ).then((result) => {
        env = result
      })
      try {
        await vi.waitFor(() => expect(env).toBeDefined())
        expect(reconciled).toBe(false)
        expect(env).not.toHaveProperty('ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR')
      } finally {
        release()
        await Promise.all([reconcile, spawn])
        serviceSpy.mockRestore()
        vi.unstubAllEnvs()
      }
    }
  )
})
