import { describe, expect, it, vi } from 'vitest'
import { onMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty/register-handlers'
import { setLocalPtyProvider } from './pty/provider/registry'
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
vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Layout-owner build: a view's painted-restore ack is main's to apply, for the pane's current terminal.
const PANE = { worktreeId: 'repo::/wt', tabId: 'tab-1', leafId: 'leaf-1' }

describe('a painted cold-restore ack in the layout-owner build', () => {
  const { mainWindow } = setupPtyIpcSuite()

  function ackWith(boundPtyId: string, args: unknown): ReturnType<typeof vi.fn> {
    const ackColdRestore = vi.fn()
    const isRestoredPaneBoundTo = (_pane: unknown, ptyId: string): boolean => ptyId === boundPtyId
    // Only the binding read matters here; every other runtime hook the handlers install is inert.
    const runtime = new Proxy(
      {},
      { get: (_target, key) => (key === 'isRestoredPaneBoundTo' ? isRestoredPaneBoundTo : vi.fn()) }
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Proxy answers every runtime hook the handlers install.
    registerPtyHandlers(mainWindow, runtime as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ack listener calls only ackColdRestore.
    setLocalPtyProvider({ ackColdRestore } as never)
    const call = onMock.mock.calls.findLast((entry: unknown[]) => entry[0] === 'pty:ackColdRestore')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ipcMain.on registered this channel with an (event, args) listener.
    const listener = call?.[1] as (event: unknown, args: unknown) => void
    listener(null, args)
    return ackColdRestore
  }

  it('releases the terminal service copy for the pane’s current terminal', () => {
    expect(ackWith('pty-1', { id: 'pty-1', pane: PANE })).toHaveBeenCalledWith('pty-1')
  })

  it('keeps it when a stale view acks a terminal the pane no longer binds', () => {
    expect(ackWith('pty-new', { id: 'pty-old', pane: PANE })).not.toHaveBeenCalled()
  })

  it('keeps it for an ack that names no pane', () => {
    expect(ackWith('pty-1', { id: 'pty-1' })).not.toHaveBeenCalled()
  })
})
