import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { createDaemonActiveProviderFixtures } from './pty-ipc-daemon-provider-fixtures'
import { registerPtyHandlers } from './register-handlers'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pty/shell-startup/pwsh', () =>
  import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock())
)
vi.mock('../../wsl/filesystem/unc-path-access', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/configuration/homes/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/history/index/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)
vi.mock('../../agent-hooks/wsl-agent-plugin-readiness', () => ({
  awaitExplicitAgentPluginGuestReadiness: vi.fn(async () => true)
}))

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow, recoveredAgentClaim, recoveredAgentSurface } = setupPtyIpcSuite()

  describe('spawn environment', () => {
    describe('daemon-active provider (parity with LocalPtyProvider)', () => {
      const { setupDaemonAdapter } = createDaemonActiveProviderFixtures({
        handlers,
        mainWindow
      })

      // Daemon spawns bypass LocalPtyProvider.buildSpawnEnv; main must inject host-local environment.

      it('does not downgrade a structured claim after dispatch reaches an old daemon', async () => {
        const daemonSpawn = setupDaemonAdapter(true, undefined, false)
        let controller:
          | { spawn: (args: Record<string, unknown>) => Promise<{ id: string }> }
          | undefined
        const runtime = {
          setPtyController: vi.fn((next) => {
            controller = next
          }),
          registerPreAllocatedHandleForPty: vi.fn(),
          registerPty: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)

        await expect(
          controller!.spawn({
            cols: 80,
            rows: 24,
            worktreeId: recoveredAgentSurface.worktreeId,
            tabId: recoveredAgentSurface.tabId,
            leafId: recoveredAgentSurface.leafId,
            command: "codex resume 'provider-session-1'",
            agentSessionEnsure: {
              claim: recoveredAgentClaim,
              surface: recoveredAgentSurface
            }
          })
        ).rejects.toThrow('agent_session_claim_unavailable')

        expect(daemonSpawn).not.toHaveBeenCalled()
      })
    })
  })
})
