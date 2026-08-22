import { describe, expect, it, vi } from 'vitest'
import { onMock, spawnMock, trackMock, classifyErrorMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers, setLocalPtyProvider } from './pty'

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

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow, createMockProc, installObservableDaemonTestProvider } =
    setupPtyIpcSuite()

  describe('agent_started telemetry', () => {
    // Why: telemetry-plan.md§Agent launch semantics — agent_started fires only after provider.spawn resolves; a malformed payload must not emit a silent event.
    // Why: telemetry-plan.md§Agent launch semantics — agent_started fires only after provider.spawn resolves; a malformed payload must not emit a silent event.
    it('emits agent_started after a successful spawn when telemetry is supplied', async () => {
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        telemetry: {
          agent_kind: 'claude-code',
          launch_source: 'new_workspace_composer',
          request_kind: 'new'
        }
      })
      expect(trackMock).toHaveBeenCalledWith('agent_started', {
        agent_kind: 'claude-code',
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      })
    })
    it('does not emit agent_started when telemetry is omitted (bare-shell tab)', async () => {
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })
      expect(trackMock).not.toHaveBeenCalled()
    })
    it('drops the event when any telemetry field is outside its closed enum', async () => {
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        telemetry: {
          agent_kind: 'claude-code',
          launch_source: 'not_a_real_surface',
          request_kind: 'new'
        }
      })
      expect(trackMock).not.toHaveBeenCalledWith('agent_started', expect.anything())
    })
    it('does not emit agent_started when provider.spawn throws', async () => {
      // Why: agent_started fires only on confirmed launch — inject a throwing provider to hit the catch path with no race against the real LocalPtyProvider.
      setLocalPtyProvider({
        spawn: vi.fn(async () => {
          throw new Error('spawn boom')
        }),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        shutdown: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        listProcesses: vi.fn(async () => []),
        getForegroundProcess: vi.fn(async () => null)
      } as never)
      classifyErrorMock.mockReturnValue({ error_class: 'unknown' })
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          command: 'claude',
          telemetry: {
            agent_kind: 'claude-code',
            launch_source: 'new_workspace_composer',
            request_kind: 'new'
          }
        })
      ).rejects.toThrow(/spawn boom/)
      expect(trackMock).not.toHaveBeenCalledWith('agent_started', expect.anything())
    })
  })
  describe('serializeBuffer dispatch', () => {
    type SerializeListener = (
      _event: unknown,
      args: {
        requestId?: string
        snapshot?: { data?: unknown; cols?: unknown; rows?: unknown; lastTitle?: unknown } | null
      }
    ) => void
    type SerializeController = {
      serializeBuffer: (
        ptyId: string,
        opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
      ) => Promise<{ data: string; cols: number; rows: number; lastTitle?: string } | null>
    }

    function setup(): { listener: SerializeListener; controller: SerializeController } {
      const runtime = {
        setPtyController: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyData: vi.fn(),
        onPtyExit: vi.fn(),
        preAllocateHandleForPty: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const onCall = onMock.mock.calls.find(
        (call: unknown[]) => call[0] === 'pty:serializeBuffer:response'
      )
      if (!onCall) {
        throw new Error('expected pty:serializeBuffer:response listener registration')
      }
      const listener = onCall[1] as SerializeListener
      const controller = runtime.setPtyController.mock.calls[0]?.[0] as SerializeController
      return { listener, controller }
    }

    function getSentRequestIds(): string[] {
      return mainWindow.webContents.send.mock.calls
        .filter((call: unknown[]) => call[0] === 'pty:serializeBuffer:request')
        .map((call: unknown[]) => (call[1] as { requestId: string }).requestId)
    }

    it('registers exactly one persistent listener regardless of concurrent in-flight requests', async () => {
      const { listener, controller } = setup()
      const inflight = [
        controller.serializeBuffer('pty-1'),
        controller.serializeBuffer('pty-2'),
        controller.serializeBuffer('pty-3'),
        controller.serializeBuffer('pty-4'),
        controller.serializeBuffer('pty-5'),
        controller.serializeBuffer('pty-6'),
        controller.serializeBuffer('pty-7'),
        controller.serializeBuffer('pty-8'),
        controller.serializeBuffer('pty-9'),
        controller.serializeBuffer('pty-10'),
        controller.serializeBuffer('pty-11'),
        controller.serializeBuffer('pty-12')
      ]
      // Why: the bug registered one listener per request, so 12 concurrent calls would trip Node's MaxListeners.
      const responseChannelRegistrations = onMock.mock.calls.filter(
        (call: unknown[]) => call[0] === 'pty:serializeBuffer:response'
      )
      expect(responseChannelRegistrations.length).toBe(1)
      // Drain the in-flight requests so the test doesn't leak timers.
      for (const requestId of getSentRequestIds()) {
        listener(null, { requestId, snapshot: null })
      }
      await Promise.all(inflight)
    })
    it('routes each response to the originating request via requestId', async () => {
      const { listener, controller } = setup()
      const a = controller.serializeBuffer('pty-a')
      const b = controller.serializeBuffer('pty-b')
      const ids = getSentRequestIds()
      const requestIdA = ids[0]
      const requestIdB = ids[1]

      listener(null, {
        requestId: requestIdB,
        snapshot: { data: 'B-data', cols: 80, rows: 24 }
      })
      listener(null, {
        requestId: requestIdA,
        snapshot: { data: 'A-data', cols: 100, rows: 30, lastTitle: 'A-title' }
      })

      await expect(b).resolves.toEqual({ data: 'B-data', cols: 80, rows: 24 })
      await expect(a).resolves.toEqual({
        data: 'A-data',
        cols: 100,
        rows: 30,
        lastTitle: 'A-title'
      })
    })
    it('ignores responses with unknown requestId without affecting pending requests', async () => {
      const { listener, controller } = setup()
      const pending = controller.serializeBuffer('pty-1')
      const realRequestId = getSentRequestIds()[0]

      listener(null, {
        requestId: 'not-a-real-id',
        snapshot: { data: 'irrelevant', cols: 1, rows: 1 }
      })
      listener(null, { requestId: undefined, snapshot: null })

      let resolved = false
      void pending.then(() => {
        resolved = true
      })
      await new Promise((r) => setTimeout(r, 0))
      expect(resolved).toBe(false)

      listener(null, { requestId: realRequestId, snapshot: { data: 'ok', cols: 80, rows: 24 } })
      await expect(pending).resolves.toEqual({ data: 'ok', cols: 80, rows: 24 })
    })
    it('resolves to null and removes the entry when the 750ms timeout fires', async () => {
      vi.useFakeTimers()
      try {
        const { controller } = setup()
        const pending = controller.serializeBuffer('pty-stuck')
        vi.advanceTimersByTime(750)
        await expect(pending).resolves.toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })
    it('resolves to null when the response snapshot is malformed', async () => {
      const { listener, controller } = setup()
      const pending = controller.serializeBuffer('pty-bad')
      const requestId = getSentRequestIds()[0]
      listener(null, { requestId, snapshot: { data: 'ok', cols: 'not-a-number' } })
      await expect(pending).resolves.toBeNull()
    })
  })
  describe('provider buffer snapshot dispatch', () => {
    it('exposes daemon history when no renderer pane is mounted', async () => {
      const provider = installObservableDaemonTestProvider()
      provider.getBufferSnapshot.mockResolvedValue({
        data: 'restored screen\r\n',
        scrollbackAnsi: 'restored history\r\n',
        cols: 120,
        rows: 40,
        cwd: '/projects/restored',
        seq: 900,
        source: 'headless'
      })
      const runtime = { setPtyController: vi.fn() }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
        serializeProviderBuffer(ptyId: string, opts?: { scrollbackRows?: number }): Promise<unknown>
      }

      await expect(
        controller.serializeProviderBuffer('daemon-restored', { scrollbackRows: 5000 })
      ).resolves.toEqual({
        data: 'restored screen\r\n',
        scrollbackAnsi: 'restored history\r\n',
        cols: 120,
        rows: 40,
        cwd: '/projects/restored',
        seq: 900,
        source: 'headless'
      })
      expect(provider.getBufferSnapshot).toHaveBeenCalledWith('daemon-restored', {
        scrollbackRows: 5000
      })
    })
  })
  describe('main buffer snapshot dispatch', () => {
    it('returns a hidden-output recovery snapshot with clamped scrollback', async () => {
      const runtime = {
        setPtyController: vi.fn(),
        getPtyOutputSequence: vi.fn(() => 42),
        serializeHiddenOutputRecoveryBuffer: vi.fn().mockResolvedValue({
          data: 'snapshot\r\n',
          cols: 120,
          rows: 40,
          cwd: '/projects/restored',
          seq: 42,
          source: 'headless'
        })
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)

      const result = await handlers.get('pty:getMainBufferSnapshot')!(null, {
        id: 'pty-1',
        opts: { scrollbackRows: 999_999 }
      })

      expect(runtime.serializeHiddenOutputRecoveryBuffer).toHaveBeenCalledWith('pty-1', {
        scrollbackRows: 50_000
      })
      // Why pendingDeliveryStartSeq === seq: pending delivery queue is empty, so low-seq live chunks must not be dropped against the snapshot baseline.
      expect(result).toEqual({
        data: 'snapshot\r\n',
        cols: 120,
        rows: 40,
        cwd: '/projects/restored',
        seq: 42,
        pendingDeliveryStartSeq: 42,
        source: 'headless'
      })
    })
    it('uses the complete provider model after daemon stream thinning', async () => {
      const provider = installObservableDaemonTestProvider()
      provider.getBufferSnapshot.mockResolvedValue({
        data: 'complete daemon scrollback\r\n',
        cols: 100,
        rows: 30,
        seq: 900,
        source: 'headless'
      })
      const runtime = {
        setPtyController: vi.fn(),
        getPtyOutputSequence: vi.fn(() => 640),
        notePtyDataGap: vi.fn(),
        onPtyExit: vi.fn(),
        serializeHiddenOutputRecoveryBuffer: vi.fn().mockResolvedValue({
          data: 'kept tail only\r\n',
          cols: 100,
          rows: 30,
          seq: 640,
          source: 'headless'
        })
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      provider.emitDataGap('daemon-pty', 512)

      const result = await handlers.get('pty:getMainBufferSnapshot')!(null, {
        id: 'daemon-pty',
        opts: { scrollbackRows: 5000 }
      })

      expect(runtime.notePtyDataGap).toHaveBeenCalledWith('daemon-pty', 512)
      expect(provider.getBufferSnapshot).toHaveBeenCalledWith('daemon-pty', {
        scrollbackRows: 5000
      })
      expect(runtime.serializeHiddenOutputRecoveryBuffer).not.toHaveBeenCalled()
      expect(result).toEqual({
        data: 'complete daemon scrollback\r\n',
        cols: 100,
        rows: 30,
        seq: 900,
        source: 'headless',
        // Bytes between main's absolute seq and the daemon snapshot may still be queued on the stream socket and must dedupe on arrival.
        pendingDeliveryStartSeq: 640
      })
      provider.emitExit('daemon-pty')
    })
    it("never paints main's incomplete tail when a required provider snapshot is unavailable", async () => {
      const provider = installObservableDaemonTestProvider()
      provider.getBufferSnapshot.mockResolvedValue(null)
      const runtime = {
        setPtyController: vi.fn(),
        getPtyOutputSequence: vi.fn(() => 640),
        notePtyDataGap: vi.fn(),
        onPtyExit: vi.fn(),
        serializeHiddenOutputRecoveryBuffer: vi.fn().mockResolvedValue({
          data: 'kept tail only\r\n',
          cols: 100,
          rows: 30,
          seq: 640,
          source: 'headless'
        })
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      provider.emitDataGap('daemon-pty', 512)

      const result = await handlers.get('pty:getMainBufferSnapshot')!(null, {
        id: 'daemon-pty',
        opts: { scrollbackRows: 5000 }
      })

      expect(provider.getBufferSnapshot).toHaveBeenCalledWith('daemon-pty', {
        scrollbackRows: 5000
      })
      expect(runtime.serializeHiddenOutputRecoveryBuffer).not.toHaveBeenCalled()
      expect(result).toBeNull()
      provider.emitExit('daemon-pty')
    })
    it('reports where the undelivered pending backlog starts alongside the snapshot', async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)
      const runtime = {
        setPtyController: vi.fn(),
        registerPty: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(),
        preAllocateHandleForPty: vi.fn(() => null),
        getPtyOutputSequence: vi.fn(() => 2_472),
        hasRemoteTerminalViewSubscriber: vi.fn(() => false),
        serializeHiddenOutputRecoveryBuffer: vi.fn().mockResolvedValue({
          data: 'snapshot\r\n',
          cols: 100,
          rows: 30,
          seq: 2_472,
          source: 'headless'
        })
      }
      try {
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })) as { id: string }

        // Starved pending entry: bytes ingested but not yet flushed to the renderer — they can still arrive after the snapshot.
        mockProc.emitData('frame-bytes')

        const result = (await handlers.get('pty:getMainBufferSnapshot')!(null, {
          id: spawnResult.id
        })) as { pendingDeliveryStartSeq?: number }

        expect(result.pendingDeliveryStartSeq).toBe(2_472 - 'frame-bytes'.length)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
