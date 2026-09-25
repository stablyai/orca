import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { redactPtyIdForDiagnostics } from '../../shared/pty-delivery-diagnostics'
import { registerPtyHandlers, getPtyRendererDeliveryDebugSnapshot } from './pty'

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
  const {
    handlers,
    mainWindow,
    mainWindowIpcEvent,
    createMockProc,
    installObservableDaemonTestProvider,
    getPtyWriteListener,
    getPtyAckDataListener,
    getPtySetActiveRendererPtyListener,
    getPtySetRendererPtyVisibleListener,
    getMainFrameNavigationListener,
    getPtySetHiddenRendererPtyListener,
    getPtySetDeliveryInterestListener
  } = setupPtyIpcSuite()

  describe('hidden renderer delivery gate', () => {
    it('foregrounds a preserved daemon PTY after handler recreation loses sync memory', async () => {
      const daemon = installObservableDaemonTestProvider()
      const firstRuntime = {
        setPtyController: vi.fn(),
        hasRawTerminalViewSubscriber: vi.fn(() => false),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn()
      }
      registerPtyHandlers(mainWindow as never, firstRuntime as never)
      const result = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        sessionId: 'daemon-session'
      })) as { id: string }

      getPtySetRendererPtyVisibleListener()(null, { id: result.id, visible: false })
      expect(daemon.setPtyBackgrounded).toHaveBeenLastCalledWith(result.id, true)

      daemon.setPtyBackgrounded.mockClear()
      handlers.clear()
      let rawSubscriberPresent = false
      const nextRuntime = {
        setPtyController: vi.fn(),
        hasRawTerminalViewSubscriber: vi.fn(() => rawSubscriberPresent),
        onRemoteTerminalViewPresenceChanged: null as ((id: string) => void) | null,
        registerRawTerminalViewSubscriber(id: string): void {
          rawSubscriberPresent = true
          this.onRemoteTerminalViewPresenceChanged?.(id)
        }
      }
      registerPtyHandlers(mainWindow as never, nextRuntime as never)

      nextRuntime.registerRawTerminalViewSubscriber(result.id)
      // Repeated presence signals must remain deduplicated.
      nextRuntime.onRemoteTerminalViewPresenceChanged?.(result.id)

      expect(daemon.setPtyBackgrounded).toHaveBeenCalledOnce()
      expect(daemon.setPtyBackgrounded).toHaveBeenCalledWith(result.id, false)
    })
    it('drops hidden PTY data after model ingestion and emits one out-of-band restore marker', async () => {
      vi.useFakeTimers()
      const runtime = {
        setPtyController: vi.fn(),
        registerPty: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(() => 42),
        getPtyOutputSequence: vi.fn(() => 42),
        hasRemoteTerminalViewSubscriber: vi.fn(() => false),
        createPreAllocatedTerminalHandle: vi.fn(() => 'terminal-handle-1'),
        registerPreAllocatedHandleForPty: vi.fn()
      }
      const daemon = installObservableDaemonTestProvider()
      try {
        registerPtyHandlers(mainWindow as never, runtime as never)
        const result = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          sessionId: 'daemon-session'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: result.id, hidden: true })
        daemon.emitData(result.id, 'hidden output')
        vi.advanceTimersByTime(50)

        // Model ingestion still ran — only renderer delivery was dropped.
        expect(runtime.onPtyData).toHaveBeenCalledWith(
          result.id,
          'hidden output',
          expect.any(Number),
          'hidden output'.length,
          undefined
        )
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        // Why out-of-band: an in-band empty pty:data chunk is ambiguous with chunks fully consumed by renderer OSC-9999 stripping.
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: result.id,
          reason: 'hidden-drop',
          markerSeq: 42
        })

        // Subsequent gated chunks drop silently — the marker is one-shot.
        daemon.emitData(result.id, 'more hidden output')
        vi.advanceTimersByTime(50)
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          hiddenDeliveryGatedPtyCount: 1,
          hiddenDeliveryGatedVisiblePtyCount: 0,
          hiddenDeliveryGatedActivePtyCount: 0,
          hiddenDeliveryDroppedChars: 'hidden output'.length + 'more hidden output'.length,
          hiddenDeliveryDroppedChunks: 2,
          pendingPtyCount: 0,
          rendererInFlightChars: 0
        })
      } finally {
        vi.useRealTimers()
      }
    })
    it('surfaces the hidden-yet-visible contradiction in the snapshot and warns on drop', async () => {
      // Why: field snapshot v1.4.124-rc.2.perf — aggregates couldn't tell if the visible pane was hidden-gated; overlap counter + warn makes it decisive.
      vi.useFakeTimers()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const daemon = installObservableDaemonTestProvider()
      try {
        registerPtyHandlers(mainWindow as never)
        const result = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          sessionId: 'daemon-session'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        const setVisible = getPtySetRendererPtyVisibleListener()

        // The two visibility signals contradict: pane reports visible while the hidden-delivery gate still holds it.
        setVisible(null, { id: result.id, visible: true })
        setHidden(null, { id: result.id, hidden: true })
        daemon.emitData(result.id, 'starved visible output')
        vi.advanceTimersByTime(50)

        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          hiddenDeliveryGatedPtyCount: 1,
          hiddenDeliveryGatedVisiblePtyCount: 1,
          hiddenDeliveryDroppedChars: 'starved visible output'.length
        })
        expect(warnSpy).toHaveBeenCalledWith(
          '[pty] hidden-delivery gate is dropping bytes for a visible/active pty',
          expect.objectContaining({ id: redactPtyIdForDiagnostics(result.id), visible: true })
        )

        // Unhiding resolves the contradiction.
        setHidden(null, { id: result.id, hidden: false })
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          hiddenDeliveryGatedPtyCount: 0,
          hiddenDeliveryGatedVisiblePtyCount: 0
        })
      } finally {
        warnSpy.mockRestore()
        vi.useRealTimers()
      }
    })
    it('embeds one-paste freeze diagnostics: per-pty table and breadcrumb history', async () => {
      vi.useFakeTimers()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const daemon = installObservableDaemonTestProvider()
      try {
        registerPtyHandlers(mainWindow as never)
        const result = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          sessionId: 'daemon-session'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        const setVisible = getPtySetRendererPtyVisibleListener()
        setVisible(null, { id: result.id, visible: true })
        setHidden(null, { id: result.id, hidden: true })
        daemon.emitData(result.id, 'starved visible output')
        vi.advanceTimersByTime(50)

        const { diagnostics } = getPtyRendererDeliveryDebugSnapshot()
        expect(diagnostics.appVersion).toBe('0.0.0-test')
        expect(diagnostics.windowFocused).toBe(true)
        expect(diagnostics.windowVisible).toBe(true)
        const entry = diagnostics.perPty.find(
          (candidate) => candidate.id === redactPtyIdForDiagnostics(result.id)
        )
        expect(entry).toMatchObject({
          hidden: true,
          visible: true,
          inFlightChars: 0,
          pendingChars: 0
        })
        // Why redaction is pinned: daemon session ids embed worktree paths, so the report must never carry the raw id.
        expect(diagnostics.perPty.some((candidate) => candidate.id === result.id)).toBe(false)
        const breadcrumbKinds = diagnostics.breadcrumbs.map((crumb) => crumb.kind)
        expect(breadcrumbKinds).toContain('gate-mark')
        expect(breadcrumbKinds).toContain('hidden-drop-visible')
      } finally {
        warnSpy.mockRestore()
        vi.useRealTimers()
      }
    })
    it('keeps the interactive bypass gated for hidden PTYs', async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })) as { id: string }
        const writeListener = getPtyWriteListener()
        const setHidden = getPtySetHiddenRendererPtyListener()

        writeListener(mainWindowIpcEvent, { id: spawnResult.id, data: 'a' })
        setHidden(null, { id: spawnResult.id, hidden: true })
        mainWindow.webContents.send.mockClear()

        // A keystroke-sized redraw would take the immediate path when visible.
        mockProc.emitData('\x1b[20;2Hredraw')
        vi.advanceTimersByTime(2)

        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: spawnResult.id,
          reason: 'hidden-drop'
        })
      } finally {
        vi.useRealTimers()
      }
    })
    it('suppresses the gate while renderer delivery interest is registered', async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        const setInterest = getPtySetDeliveryInterestListener()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: spawnResult.id, hidden: true })
        setInterest(null, { id: spawnResult.id, interested: true })
        mockProc.emitData('sidecar bytes')
        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
          id: spawnResult.id,
          data: 'sidecar bytes'
        })

        setInterest(null, { id: spawnResult.id, interested: false })
        mainWindow.webContents.send.mockClear()
        mockProc.emitData('gated bytes')
        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: spawnResult.id,
          reason: 'hidden-drop'
        })
      } finally {
        vi.useRealTimers()
      }
    })
    it('drops queued hidden data when interest ends before dispatcher readiness', async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        const setInterest = getPtySetDeliveryInterestListener()
        const setActive = getPtySetActiveRendererPtyListener()
        getMainFrameNavigationListener()()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: spawnResult.id, hidden: true })
        setInterest(null, { id: spawnResult.id, interested: true })
        mockProc.emitData('boot-window sidecar bytes')
        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).not.toHaveBeenCalled()
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          pendingPtyCount: 1,
          rendererPtyDispatcherReady: false,
          ackGatedFlushSkipCount: 0
        })

        const timerCountBeforeNoops = vi.getTimerCount()
        setHidden(null, { id: spawnResult.id, hidden: true })
        setInterest(null, { id: spawnResult.id, interested: true })
        setActive(null, { id: spawnResult.id, active: false })
        expect(vi.getTimerCount()).toBe(timerCountBeforeNoops)

        setInterest(null, { id: spawnResult.id, interested: false })
        vi.advanceTimersByTime(0)

        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: spawnResult.id,
          reason: 'hidden-drop'
        })
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          pendingPtyCount: 0,
          rendererPtyDispatcherReady: false,
          ackGatedFlushSkipCount: 0
        })
      } finally {
        vi.useRealTimers()
      }
    })
    it.each([
      ['terminalHiddenDeliveryGate', { terminalHiddenDeliveryGate: false }],
      ['terminalMainSideEffectAuthority', { terminalMainSideEffectAuthority: false }]
    ])('keeps delivery when the %s kill switch is off', async (_name, settings) => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never, undefined, undefined, (() => settings) as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: spawnResult.id, hidden: true })
        mockProc.emitData('still delivered')
        vi.advanceTimersByTime(2)

        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
          id: spawnResult.id,
          data: 'still delivered'
        })
      } finally {
        vi.useRealTimers()
      }
    })
    it.each(['terminalHiddenDeliveryGate', 'terminalMainSideEffectAuthority'] as const)(
      'reevaluates blocked hidden data when the live %s setting enables the derived gate',
      async (settingName) => {
        vi.useFakeTimers()
        const mockProc = createMockProc()
        spawnMock.mockReturnValue(mockProc.proc)
        const settings = {
          terminalHiddenDeliveryGate: true,
          terminalMainSideEffectAuthority: true
        }
        settings[settingName] = false

        try {
          registerPtyHandlers(mainWindow as never, undefined, undefined, (() => settings) as never)
          const spawnResult = (await handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            cwd: '/tmp'
          })) as { id: string }
          getMainFrameNavigationListener()()
          getPtySetHiddenRendererPtyListener()(null, { id: spawnResult.id, hidden: true })
          mainWindow.webContents.send.mockClear()
          mockProc.emitData('blocked while gate disabled')
          vi.advanceTimersByTime(2)
          expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
            pendingPtyCount: 1,
            rendererPtyDispatcherReady: false
          })

          settings[settingName] = true
          getPtyAckDataListener()(null, { id: spawnResult.id, processedChars: 0 })
          vi.advanceTimersByTime(0)

          expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
            id: spawnResult.id,
            reason: 'hidden-drop'
          })
          expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
            pendingPtyCount: 0,
            rendererPtyDispatcherReady: false
          })
        } finally {
          vi.useRealTimers()
        }
      }
    )
    it('drops queued pending data when a PTY is marked hidden', async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        mainWindow.webContents.send.mockClear()

        mockProc.emitData('queued before hidden')
        expect(mainWindow.webContents.send).not.toHaveBeenCalled()
        setHidden(null, { id: spawnResult.id, hidden: true })

        // The queued bytes are model-owned; only the restore marker goes out.
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: spawnResult.id,
          reason: 'hidden-drop'
        })
        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({ pendingPtyCount: 0 })
      } finally {
        vi.useRealTimers()
      }
    })
    it('re-emits the restore marker on unhide and resumes delivery', async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: spawnResult.id, hidden: true })
        mockProc.emitData('dropped while hidden')
        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)

        // Why: a renderer reload can replace the view that latched restore-needed; unhide repeats the marker so the live view heals.
        setHidden(null, { id: spawnResult.id, hidden: false })
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(2)
        expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:modelRestoreNeeded', {
          id: spawnResult.id,
          reason: 'unhide'
        })

        mockProc.emitData('visible again')
        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:data', {
          id: spawnResult.id,
          data: 'visible again'
        })
      } finally {
        vi.useRealTimers()
      }
    })
    it('does not emit an unhide marker when nothing was dropped', async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: spawnResult.id, hidden: true })
        setHidden(null, { id: spawnResult.id, hidden: false })

        expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })
    it('clears gate state on PTY exit', async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()

        setHidden(null, { id: spawnResult.id, hidden: true })
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          hiddenDeliveryGatedPtyCount: 1
        })

        mockProc.emitExit(0)
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          hiddenDeliveryGatedPtyCount: 0,
          deliveryInterestPtyCount: 0
        })
      } finally {
        vi.useRealTimers()
      }
    })
    it('keeps drop memory across a hidden remount so reveal still restores', async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: spawnResult.id, hidden: true })
        mockProc.emitData('dropped while hidden')
        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)

        // Why: a hidden remount (tab move, parking handoff) re-marks without an unhide, so re-marking must NOT erase drop memory.
        setHidden(null, { id: spawnResult.id, hidden: true })
        setHidden(null, { id: spawnResult.id, hidden: false })

        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(2)
        expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:modelRestoreNeeded', {
          id: spawnResult.id,
          reason: 'unhide'
        })
      } finally {
        vi.useRealTimers()
      }
    })
    it('keeps drop memory across a renderer reload while clearing hidden/interest state', async () => {
      vi.useFakeTimers()
      const runtime = {
        setPtyController: vi.fn(),
        registerPty: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(() => 42),
        getPtyOutputSequence: vi.fn(() => 42),
        hasRemoteTerminalViewSubscriber: vi.fn(() => false),
        createPreAllocatedTerminalHandle: vi.fn(() => 'terminal-handle-1'),
        registerPreAllocatedHandleForPty: vi.fn()
      }
      const daemon = installObservableDaemonTestProvider()
      try {
        registerPtyHandlers(mainWindow as never, runtime as never)
        // Why daemon provider: survives reloads and keeps orphan-kill off this webContents, so 'did-finish-load' means gate reset only.
        const reloadHandlers = mainWindow.webContents.on.mock.calls
          .filter((call: unknown[]) => call[0] === 'did-finish-load')
          .map((call: unknown[]) => call[1] as () => void)
        expect(reloadHandlers).toHaveLength(1)
        const result = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          sessionId: 'daemon-session'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: result.id, hidden: true })
        daemon.emitData(result.id, 'dropped while hidden')
        vi.advanceTimersByTime(50)
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)

        // Renderer reload: hidden marks die with the old renderer, but dropped bytes were never restored — memory must survive.
        reloadHandlers[0]()
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          hiddenDeliveryGatedPtyCount: 0
        })

        // The reloaded pane's first sync re-marks hidden, then reveals.
        setHidden(null, { id: result.id, hidden: true })
        setHidden(null, { id: result.id, hidden: false })
        expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:modelRestoreNeeded', {
          id: result.id,
          reason: 'unhide',
          markerSeq: 42
        })
      } finally {
        vi.useRealTimers()
      }
    })
    it('clears leaked delivery interest on renderer reload so the gate re-engages', async () => {
      vi.useFakeTimers()
      const runtime = {
        setPtyController: vi.fn(),
        registerPty: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(() => 42),
        getPtyOutputSequence: vi.fn(() => 42),
        hasRemoteTerminalViewSubscriber: vi.fn(() => false),
        createPreAllocatedTerminalHandle: vi.fn(() => 'terminal-handle-1'),
        registerPreAllocatedHandleForPty: vi.fn()
      }
      const daemon = installObservableDaemonTestProvider()
      try {
        registerPtyHandlers(mainWindow as never, runtime as never)
        const reloadHandlers = mainWindow.webContents.on.mock.calls
          .filter((call: unknown[]) => call[0] === 'did-finish-load')
          .map((call: unknown[]) => call[1] as () => void)
        expect(reloadHandlers).toHaveLength(1)
        const result = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          sessionId: 'daemon-session'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        const setInterest = getPtySetDeliveryInterestListener()
        mainWindow.webContents.send.mockClear()

        // A sidecar holds interest, so hidden bytes still flow.
        setInterest(null, { id: result.id, interested: true })
        setHidden(null, { id: result.id, hidden: true })
        daemon.emitData(result.id, 'sidecar bytes')
        vi.advanceTimersByTime(50)
        expect(mainWindow.webContents.send).toHaveBeenLastCalledWith(
          'pty:data',
          expect.objectContaining({ id: result.id, data: 'sidecar bytes' })
        )

        // Why: the renderer reload killed the sidecar's ref count without a release IPC — the leaked hold must not force-feed the PTY forever.
        reloadHandlers[0]()
        mainWindow.webContents.send.mockClear()
        setHidden(null, { id: result.id, hidden: true })
        daemon.emitData(result.id, 'gated after reload')
        vi.advanceTimersByTime(50)

        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: result.id,
          reason: 'hidden-drop',
          markerSeq: 42
        })
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
