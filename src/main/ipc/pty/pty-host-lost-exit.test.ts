import { expect, it, vi, type MockInstance } from 'vitest'
import { setupPtyIpcSuite } from '../pty-ipc-test-harness'
import { registerPtyHandlers } from './register-handlers'
import { getLocalPtyProvider } from './provider/registry'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'

vi.mock('electron', () => import('../pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('../pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('../pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('../pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('../pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('../pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('../pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('../pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pwsh', () => import('../pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../wsl', async (importOriginal) =>
  (await import('../pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('../pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('../pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('../pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('../pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('../pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/codex-pane-account-registry', () =>
  import('../pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/codex-state-db-backfill-recovery', () =>
  import('../pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

const { handlers, mainWindow } = setupPtyIpcSuite()

type Exit = { id: string; code: number; hostLost?: true }

function registerWithProviderExits(): {
  onPtyExit: MockInstance<OrcaRuntimeService['onPtyExit']>
  emitExit: (exit: Exit) => void
} {
  const exitListeners = new Set<(payload: Exit) => void>()
  vi.spyOn(getLocalPtyProvider(), 'onExit').mockImplementation((listener) => {
    exitListeners.add(listener)
    return () => exitListeners.delete(listener)
  })
  const runtime = new OrcaRuntimeService()
  const onPtyExit = vi.spyOn(runtime, 'onPtyExit').mockImplementation(() => {})
  handlers.clear()
  registerPtyHandlers(mainWindow, runtime)
  return {
    onPtyExit,
    emitExit: (exit) => exitListeners.forEach((listener) => listener(exit))
  }
}

// The runtime keeps a lost-host pane's binding only if the provider's label reaches it.
it('tells the runtime a WSL bridge pane lost its distro', () => {
  const { onPtyExit, emitExit } = registerWithProviderExits()
  emitExit({ id: 'bridge-pty', code: -1, hostLost: true })
  expect(onPtyExit).toHaveBeenCalledWith('bridge-pty', -1, undefined, {
    providerExitObserved: true,
    hostLost: true
  })
})

it('never labels an ordinary exit as host loss', () => {
  const { onPtyExit, emitExit } = registerWithProviderExits()
  emitExit({ id: 'bridge-pty', code: 1 })
  expect(onPtyExit).toHaveBeenCalledWith('bridge-pty', 1, undefined, {
    providerExitObserved: true
  })
})
