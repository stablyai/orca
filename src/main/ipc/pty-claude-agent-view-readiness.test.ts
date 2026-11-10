import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as agentView from '../claude/agent-view/agent-view-service'
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
vi.mock('../agent-hooks/server/agent-hook-server', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pty/shell-startup/pwsh', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.pwshModuleMock())
)
vi.mock('../wsl/filesystem/unc-path-access', async (importOriginal) =>
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
vi.mock('../agent-hooks/observations/migration-unsupported-pty-state', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/configuration/homes/codex-pane-account-registry', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/history/index/codex-state-db-backfill-recovery', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe.each(['local', 'daemon'] as const)('%s PTY navigation readiness', (provider) => {
  const { handlers, mainWindow, spawnAndGetEnv } = setupPtyIpcSuite()
  const { daemonSpawnAndGetEnv } = createDaemonActiveProviderFixtures({ handlers, mainWindow })

  it('spawns a plain shell while reconciliation is pending', async () => {
    const gate = Promise.withResolvers<void>()
    const reconcileStarted = Promise.withResolvers<void>()
    const config = join(tmpdir(), 'orca-spawn-pending-agent-view-config')
    vi.stubEnv('CLAUDE_CONFIG_DIR', config)
    const service = new agentView.ClaudeAgentViewService(
      join(tmpdir(), 'orca-spawn-pending-agent-view'),
      {
        reconcileConfig: () => {
          reconcileStarted.resolve()
          return gate.promise
        },
        ensurePlugin: async () => join(tmpdir(), 'orca-spawn-agent-view-plugin'),
        loginEnv: async () => ({ CLAUDE_CONFIG_DIR: config }),
        listProfiles: async () => []
      }
    )
    const serviceSpy = vi.spyOn(agentView, 'getClaudeAgentViewService').mockReturnValue(service)
    // Runs on timeout too, when a regressed spawn never settles.
    onTestFinished(() => {
      gate.resolve()
      serviceSpy.mockRestore()
      vi.unstubAllEnvs()
    })
    const settings = createGlobalSettingsFixture({ claudeSubagentNavigationEnabled: true })
    const reconcile = service.reconcile(settings)
    await reconcileStarted.promise
    const env = await (provider === 'daemon'
      ? daemonSpawnAndGetEnv({}, undefined, () => settings)
      : spawnAndGetEnv({}, undefined, undefined, () => settings))
    expect(env).not.toHaveProperty('ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR')
    gate.resolve()
    await reconcile
  })
})
