import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty/register-handlers'
import { getLocalPtyProvider, setLocalPtyProvider } from './pty/provider/registry'
import { rebindLocalProviderListeners } from './pty/provider/listener-lifecycle'
import { DegradedDaemonPtyProvider } from '../daemon/degraded-daemon-pty-provider'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import type { PtyDataEvent } from '../providers/pty-provider-events'
import { OrcaRuntimeService } from '../runtime/orca-runtime'

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
function createUnhealthyDaemonAdapter(daemonData: ((payload: PtyDataEvent) => void)[]) {
  return {
    spawn: vi.fn(async () => {
      throw new Error('fresh spawns must not reach the unhealthy daemon')
    }),
    listProcesses: vi.fn(async () => []),
    onData: vi.fn((cb: (payload: PtyDataEvent) => void) => {
      daemonData.push(cb)
      return () => {}
    }),
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
    const runtime = new OrcaRuntimeService()
    const onPtyData = vi.spyOn(runtime, 'onPtyData')
    const onPtyExit = vi.spyOn(runtime, 'onPtyExit')
    const daemonData: ((payload: PtyDataEvent) => void)[] = []
    try {
      handlers.clear()
      // The window registers first, so the in-process provider is configured to feed the runtime.
      registerPtyHandlers(mainWindow, runtime)
      setLocalPtyProvider(
        new DegradedDaemonPtyProvider({
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the degraded provider reaches only these adapter members on this spawn/data/exit path.
          current: createUnhealthyDaemonAdapter(daemonData) as unknown as DaemonPtyAdapter,
          legacy: [],
          fallback: getLocalPtyProvider()
        })
      )
      rebindLocalProviderListeners()

      const spawned: unknown = await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })
      if (
        !spawned ||
        typeof spawned !== 'object' ||
        !('id' in spawned) ||
        typeof spawned.id !== 'string'
      ) {
        throw new Error('pty:spawn returned no id')
      }
      const { id } = spawned
      mockProc.emitData('frame')
      daemonData.forEach((cb) => cb({ id: 'daemon-pty', data: 'daemon' }))
      await vi.advanceTimersByTimeAsync(50)

      expect(onPtyData.mock.calls).toEqual([
        [id, 'frame', expect.any(Number), 5, undefined],
        ['daemon-pty', 'daemon', expect.any(Number), 6, undefined]
      ])
      expect(runtime.getPtyOutputSequence(id)).toBe(5)
      expect(runtime.getPtyOutputSequence('daemon-pty')).toBe(6)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id,
        data: 'frame',
        seq: 5,
        rawLength: 5
      })

      mockProc.emitExit(0)
      await vi.advanceTimersByTimeAsync(50)
      expect(onPtyExit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
