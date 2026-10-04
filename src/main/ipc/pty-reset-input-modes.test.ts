import { describe, expect, it, vi } from 'vitest'
import { onMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty'

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

describe('Reset Terminal main-side entry points', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()

  function setup() {
    const resetInputModes = vi.fn(async () => {})
    installDaemonTestProvider({ resetInputModes })
    let controller: { resetInputModes: (ptyId: string) => Promise<void> } | undefined
    const runtime = {
      setPtyController: vi.fn((next) => {
        controller = next
      }),
      resetHeadlessTerminalInputModes: vi.fn(async () => {})
    }
    handlers.clear()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration reads only these members.
    registerPtyHandlers(mainWindow as never, runtime as never)
    return { resetInputModes, runtime, controller: controller! }
  }

  it('grounds the provider and the headless model from the pane IPC', () => {
    const { resetInputModes, runtime } = setup()
    const listener = onMock.mock.calls.findLast(
      (entry: unknown[]) => entry[0] === 'pty:resetInputModes'
    )?.[1]
    if (typeof listener !== 'function') {
      throw new Error('missing pty:resetInputModes listener')
    }

    listener(null, { id: 'pty-1' })

    expect(resetInputModes).toHaveBeenCalledWith('pty-1')
    expect(runtime.resetHeadlessTerminalInputModes).toHaveBeenCalledWith('pty-1')
    // The pane grounded itself before sending; echoing back would ground it twice.
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(
      'pty:resetInputModes:request',
      expect.anything()
    )
  })

  it("grounds the host window's pane and the provider for a runtime-initiated reset", async () => {
    const { resetInputModes, controller } = setup()

    await controller.resetInputModes('pty-1')

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:resetInputModes:request', {
      ptyId: 'pty-1'
    })
    expect(resetInputModes).toHaveBeenCalledWith('pty-1')
  })

  it('swallows an older host rejecting the request', async () => {
    const { resetInputModes, controller } = setup()
    resetInputModes.mockRejectedValueOnce(new Error('Unknown request type: resetInputModes'))

    await expect(controller.resetInputModes('pty-1')).resolves.toBeUndefined()
  })
})
