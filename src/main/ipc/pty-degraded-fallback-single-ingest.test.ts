import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty/register-handlers'
import { getLocalPtyProvider, setLocalPtyProvider } from './pty/provider/registry'
import { rebindLocalProviderListeners } from './pty/provider/listener-lifecycle'
import { DegradedDaemonPtyProvider } from '../daemon/degraded-daemon-pty-provider'

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

// A daemon whose PTY spawn check failed: fresh terminals go to the in-process fallback.
function createUnhealthyDaemonAdapter(): unknown {
  return {
    spawn: vi.fn(async () => {
      throw new Error('fresh spawns must not reach the unhealthy daemon')
    }),
    listProcesses: vi.fn(async () => []),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    onWriteUnavailable: vi.fn(() => () => {})
  }
}

describe('degraded daemon with in-process fallback', () => {
  const { handlers, mainWindow, createMockProc } = setupPtyIpcSuite()

  it('feeds each fallback PTY chunk and exit to the runtime once', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    let outputSeq = 0
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn((_id: string, data: string) => (outputSeq += data.length)),
      getPtyOutputSequence: vi.fn(() => outputSeq),
      preAllocateHandleForPty: vi.fn(() => null),
      hasRemoteTerminalViewSubscriber: vi.fn(() => false)
    }
    try {
      handlers.clear()
      // The window registers first, so the in-process provider is configured to feed the runtime.
      registerPtyHandlers(mainWindow as never, runtime as never)
      setLocalPtyProvider(
        new DegradedDaemonPtyProvider({
          current: createUnhealthyDaemonAdapter() as never,
          legacy: [],
          fallback: getLocalPtyProvider()
        })
      )
      rebindLocalProviderListeners()

      const { id } = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      mockProc.emitData('frame')
      await vi.advanceTimersByTimeAsync(50)

      expect(runtime.onPtyData).toHaveBeenCalledTimes(1)
      expect(runtime.onPtyData).toHaveBeenCalledWith(id, 'frame', expect.any(Number), 5, undefined)
      const dataSends = mainWindow.webContents.send.mock.calls.filter(
        (call) => call[0] === 'pty:data' && (call[1] as { id: string }).id === id
      )
      expect(dataSends.map((call) => (call[1] as { data: string }).data).join('')).toBe('frame')

      mockProc.emitExit(0)
      await vi.advanceTimersByTimeAsync(50)
      expect(runtime.onPtyExit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
