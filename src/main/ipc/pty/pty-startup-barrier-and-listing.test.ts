import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
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
vi.mock('../../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../wsl', async (importOriginal) =>
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
vi.mock('../../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()

  it('marks a session gone only when the provider answers that it is absent', async () => {
    const probePtyLiveness = vi.fn(async (id: string) =>
      id === 'dead-pty' ? false : id === 'unobserved-pty' ? null : true
    )
    registerPtyHandlers(mainWindow)
    installDaemonTestProvider({
      canProvideAuthoritativeBufferSnapshot: () => false,
      probePtyLiveness
    })

    const result = await handlers.get('pty:getAuthoritativeBufferSnapshotCapabilities')?.(null, {
      ids: ['dead-pty', 'live-unattached-pty', 'unobserved-pty']
    })

    expect(result).toEqual([
      { id: 'dead-pty', authoritative: false, gone: true },
      { id: 'live-unattached-pty', authoritative: false },
      { id: 'unobserved-pty', authoritative: false }
    ])
  })
  it('starts every liveness probe before any resolves so a slow daemon cannot outlast the batch deadline', async () => {
    const started: string[] = []
    const releases: (() => void)[] = []
    const probePtyLiveness = vi.fn(
      (id: string) =>
        new Promise<boolean>((resolve) => {
          started.push(id)
          releases.push(() => resolve(false))
        })
    )
    registerPtyHandlers(mainWindow)
    installDaemonTestProvider({
      canProvideAuthoritativeBufferSnapshot: () => false,
      probePtyLiveness
    })

    const pending = Promise.resolve(
      handlers.get('pty:getAuthoritativeBufferSnapshotCapabilities')?.(null, {
        ids: ['dead-1', 'dead-2', 'dead-3']
      })
    )
    await vi.waitFor(() => expect(started).toEqual(['dead-1', 'dead-2', 'dead-3']))
    releases.forEach((release) => release())

    await expect(pending).resolves.toEqual([
      { id: 'dead-1', authoritative: false, gone: true },
      { id: 'dead-2', authoritative: false, gone: true },
      { id: 'dead-3', authoritative: false, gone: true }
    ])
  })
})
