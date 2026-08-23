import { describe, expect, it, vi } from 'vitest'
import { onMock, spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  registerPtyHandlers,
  registerPtyRenderer,
  getPtyRendererDeliveryDebugSnapshot,
  handoffPtyRendererOwnership
} from './pty'
import { ptyRendererOwners } from './pty-renderer-owners'

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
    getPtyWriteListener,
    getPtyAckDataListener,
    getPtySetActiveRendererPtyListener,
    getPtySetRendererPtyVisibleListener,
    getPtySetHiddenRendererPtyListener,
    getPtySetDeliveryInterestListener,
    getPtyRendererDispatcherReadyListener,
    getMainWindowWebContentsListener,
    getMainFrameNavigationListener,
    foreignWindowIpcEvent
  } = setupPtyIpcSuite()
  const reportRendererViewHints = (event: unknown, id: string, enabled: boolean): void => {
    getPtySetActiveRendererPtyListener()(event, { id, active: enabled })
    getPtySetRendererPtyVisibleListener()(event, { id, visible: enabled })
    getPtySetHiddenRendererPtyListener()(event, { id, hidden: enabled })
    getPtySetDeliveryInterestListener()(event, { id, interested: enabled })
  }

  it('reloads one renderer without closing delivery for another renderer', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const secondProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc).mockReturnValueOnce(secondProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const first = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
        cols: 80,
        rows: 24
      })) as { id: string }
      const second = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
        cols: 80,
        rows: 24
      })) as { id: string }
      const secondary = foreignWindowIpcEvent.sender
      registerPtyRenderer(secondary as never)
      ptyRendererOwners.markDispatcherReady(secondary as never)
      ptyRendererOwners.handoff([second.id], mainWindow.webContents as never, secondary as never)
      const secondaryNavigation = secondary.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'did-start-navigation'
      )![1] as (details: { isMainFrame: boolean; isSameDocument: boolean }) => void
      mainWindow.webContents.send.mockClear()
      secondary.send.mockClear()

      secondaryNavigation({ isMainFrame: true, isSameDocument: false })
      firstProc.emitData('primary-stays-live')
      secondProc.emitData('secondary-held')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: first.id,
        data: 'primary-stays-live'
      })
      expect(secondary.send).not.toHaveBeenCalledWith('pty:data', expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps secondary data and exit delivery live after the control window is destroyed', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    const originalIsDestroyed = mainWindow.isDestroyed

    try {
      registerPtyHandlers(mainWindow as never)
      const result = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
        cols: 80,
        rows: 24
      })) as { id: string }
      const secondary = foreignWindowIpcEvent.sender
      registerPtyRenderer(secondary as never)
      ptyRendererOwners.markDispatcherReady(secondary as never)
      ptyRendererOwners.handoff([result.id], mainWindow.webContents as never, secondary as never)
      mainWindow.isDestroyed = () => true

      mockProc.emitData('secondary-output')
      vi.advanceTimersByTime(2)
      mockProc.emitExit(7)

      expect(secondary.send).toHaveBeenCalledWith('pty:data', {
        id: result.id,
        data: 'secondary-output'
      })
      expect(secondary.send).toHaveBeenCalledWith(
        'pty:exit',
        expect.objectContaining({ id: result.id, code: 7 })
      )
    } finally {
      mainWindow.isDestroyed = originalIsDestroyed
      vi.useRealTimers()
    }
  })

  it('preserves delivery accounting when a group handoff fails validation', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const result = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
        cols: 80,
        rows: 24
      })) as { id: string }
      const secondary = foreignWindowIpcEvent.sender
      registerPtyRenderer(secondary as never)
      ptyRendererOwners.markDispatcherReady(secondary as never)
      mockProc.emitData('accounted-output')
      vi.advanceTimersByTime(2)
      const before = getPtyRendererDeliveryDebugSnapshot()

      expect(() =>
        handoffPtyRendererOwnership(
          [result.id, 'not-owned'],
          mainWindow.webContents as never,
          secondary as never
        )
      ).toThrow('pty_renderer_not_owner')
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: before.rendererInFlightChars,
        pendingChars: before.pendingChars
      })
      expect(ptyRendererOwners.owns(result.id, mainWindow.webContents as never)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears transferred renderer hints without clearing target-owned PTYs', async () => {
    registerPtyHandlers(mainWindow as never)
    const transferred = await Promise.all(
      ['source-a', 'source-b'].map(
        async () =>
          (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
            cols: 80,
            rows: 24
          })) as { id: string }
      )
    )
    const targetOwned = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const secondary = foreignWindowIpcEvent.sender
    registerPtyRenderer(secondary as never)
    ptyRendererOwners.markDispatcherReady(secondary as never)
    ptyRendererOwners.handoff([targetOwned.id], mainWindow.webContents as never, secondary as never)
    for (const { id } of transferred) {
      reportRendererViewHints(mainWindowIpcEvent, id, true)
    }
    reportRendererViewHints(foreignWindowIpcEvent, targetOwned.id, true)

    handoffPtyRendererOwnership(
      transferred.map(({ id }) => id),
      mainWindow.webContents as never,
      secondary as never
    )

    expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
      activeRendererPtyCount: 1,
      hiddenDeliveryGatedPtyCount: 1,
      hiddenDeliveryGatedVisiblePtyCount: 1,
      deliveryInterestPtyCount: 1
    })
    reportRendererViewHints(foreignWindowIpcEvent, targetOwned.id, false)
    expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
      activeRendererPtyCount: 0,
      hiddenDeliveryGatedPtyCount: 0,
      hiddenDeliveryGatedVisiblePtyCount: 0,
      deliveryInterestPtyCount: 0
    })
  })

  it('clears only the destroyed renderer hints without a navigation signal', async () => {
    registerPtyHandlers(mainWindow as never)
    const destroyedRendererPty = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const survivingPty = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const secondary = foreignWindowIpcEvent.sender
    registerPtyRenderer(secondary as never)
    ptyRendererOwners.markDispatcherReady(secondary as never)
    ptyRendererOwners.handoff(
      [destroyedRendererPty.id],
      mainWindow.webContents as never,
      secondary as never
    )
    for (const [event, id] of [
      [foreignWindowIpcEvent, destroyedRendererPty.id],
      [mainWindowIpcEvent, survivingPty.id]
    ] as const) {
      reportRendererViewHints(event, id, true)
    }
    const destroyed = secondary.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'destroyed'
    )?.[1] as (() => void) | undefined

    expect(destroyed).toBeTypeOf('function')
    destroyed!()

    expect(ptyRendererOwners.getOwner(destroyedRendererPty.id)).toBeNull()
    expect(ptyRendererOwners.owns(survivingPty.id, mainWindow.webContents as never)).toBe(true)
    expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
      activeRendererPtyCount: 1,
      hiddenDeliveryGatedPtyCount: 1,
      hiddenDeliveryGatedVisiblePtyCount: 1,
      deliveryInterestPtyCount: 1
    })
    reportRendererViewHints(mainWindowIpcEvent, survivingPty.id, false)
    expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
      activeRendererPtyCount: 0,
      hiddenDeliveryGatedPtyCount: 0,
      hiddenDeliveryGatedVisiblePtyCount: 0,
      deliveryInterestPtyCount: 0
    })
  })

  it('orphan-sweeps only the reloading secondary renderer PTYs', async () => {
    const firstProc = createMockProc()
    const secondProc = createMockProc()
    Object.assign(secondProc.proc, { pid: 99_998, process: 'zsh' })
    const firstKill = firstProc.proc.kill
    const secondKill = secondProc.proc.kill
    spawnMock.mockReturnValueOnce(firstProc.proc).mockReturnValueOnce(secondProc.proc)
    registerPtyHandlers(mainWindow as never)
    const first = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const second = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const secondary = foreignWindowIpcEvent.sender
    registerPtyRenderer(secondary as never)
    ptyRendererOwners.markDispatcherReady(secondary as never)
    ptyRendererOwners.handoff([second.id], mainWindow.webContents as never, secondary as never)
    const navigate = secondary.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'did-start-navigation'
    )![1] as (details: { isMainFrame: boolean; isSameDocument: boolean }) => void
    const finishLoad = secondary.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'did-finish-load'
    )?.[1] as (() => void) | undefined

    expect(finishLoad).toBeTypeOf('function')
    navigate({ isMainFrame: true, isSameDocument: false })
    finishLoad!()
    ptyRendererOwners.markDispatcherReady(secondary as never)
    navigate({ isMainFrame: true, isSameDocument: false })
    finishLoad!()

    expect(firstKill).not.toHaveBeenCalled()
    expect(secondKill).toHaveBeenCalled()
    expect(ptyRendererOwners.getOwner(first.id)?.webContentsId).toBe(mainWindow.webContents.id)
  })

  it('preserves a promoted local PTY for one reload then sweeps the next manual reload', async () => {
    const mockProc = createMockProc()
    const kill = mockProc.proc.kill
    spawnMock.mockReturnValue(mockProc.proc)
    let promotionReloadId: number | null = null
    const consumedPromotionReloads: number[] = []
    const isRecoveryReloadInFlight = (webContentsId: number): boolean => {
      if (promotionReloadId !== webContentsId) {
        return false
      }
      promotionReloadId = null
      consumedPromotionReloads.push(webContentsId)
      return true
    }
    const activeListeners = (
      webContents: typeof mainWindow.webContents,
      eventName: string
    ): (() => void)[] => {
      const removed = new Set(
        webContents.removeListener.mock.calls
          .filter(([event]) => event === eventName)
          .map(([, listener]) => listener)
      )
      return webContents.on.mock.calls
        .filter(([event, listener]) => event === eventName && !removed.has(listener))
        .map(([, listener]) => listener as () => void)
    }
    const finishLoad = (webContents: typeof mainWindow.webContents): void => {
      for (const listener of activeListeners(webContents, 'did-finish-load')) {
        listener()
      }
    }
    const reload = (webContents: typeof mainWindow.webContents): void => {
      for (const listener of activeListeners(webContents, 'did-start-navigation')) {
        ;(
          listener as unknown as (details: {
            isMainFrame: boolean
            isSameDocument: boolean
          }) => void
        )({ isMainFrame: true, isSameDocument: false })
      }
      finishLoad(webContents)
    }

    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { isRecoveryReloadInFlight, reuseRegisteredState: true }
    )
    finishLoad(mainWindow.webContents)
    const result = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const secondary = foreignWindowIpcEvent.sender
    registerPtyRenderer(secondary as never)
    finishLoad(secondary)
    ptyRendererOwners.markDispatcherReady(secondary as never)
    handoffPtyRendererOwnership([result.id], mainWindow.webContents as never, secondary as never)
    registerPtyHandlers(
      { ...mainWindow, webContents: secondary } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { isRecoveryReloadInFlight, reuseRegisteredState: true }
    )

    promotionReloadId = secondary.id
    reload(secondary)

    expect(kill).not.toHaveBeenCalled()
    expect(ptyRendererOwners.getOwner(result.id)?.webContentsId).toBe(secondary.id)
    ptyRendererOwners.markDispatcherReady(secondary as never)
    getPtyWriteListener()(foreignWindowIpcEvent, { id: result.id, data: 'still-live' })
    expect(mockProc.proc.write).toHaveBeenCalledWith('still-live')
    expect(consumedPromotionReloads).toEqual([secondary.id])

    reload(secondary)

    expect(kill).toHaveBeenCalledOnce()
  })

  it('installs one lifecycle reset when an existing secondary becomes control', async () => {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const secondary = foreignWindowIpcEvent.sender
    registerPtyRenderer(secondary as never)
    ptyRendererOwners.markDispatcherReady(secondary as never)
    ptyRendererOwners.handoff([result.id], mainWindow.webContents as never, secondary as never)
    const promotedWindow = { ...mainWindow, webContents: secondary }

    registerPtyHandlers(promotedWindow as never)
    const removedNavigationListeners = new Set(
      secondary.removeListener.mock.calls
        .filter((call: unknown[]) => call[0] === 'did-start-navigation')
        .map((call: unknown[]) => call[1])
    )
    const navigationListeners = secondary.on.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'did-start-navigation' && !removedNavigationListeners.has(call[1])
    )
    const generationBefore = ptyRendererOwners.getOwner(result.id)!.generation
    for (const [, listener] of navigationListeners) {
      ;(listener as (details: { isMainFrame: boolean; isSameDocument: boolean }) => void)({
        isMainFrame: true,
        isSameDocument: false
      })
    }

    expect(navigationListeners).toHaveLength(1)
    expect(ptyRendererOwners.getOwner(result.id)!.generation).toBe(generationBefore + 1)
  })

  it('preserves secondary delivery credit when that renderer becomes control', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { reuseRegisteredState: true }
      )
      const result = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
        cols: 80,
        rows: 24
      })) as { id: string }
      const secondary = foreignWindowIpcEvent.sender
      registerPtyRenderer(secondary as never)
      ptyRendererOwners.markDispatcherReady(secondary as never)
      ptyRendererOwners.handoff([result.id], mainWindow.webContents as never, secondary as never)
      mockProc.emitData('unacknowledged')
      vi.advanceTimersByTime(2)
      const ackBeforePromotion = getPtyAckDataListener()
      const ipcListenerCountBeforePromotion = onMock.mock.calls.length
      expect(getPtyRendererDeliveryDebugSnapshot().rendererInFlightChars).toBe(14)

      registerPtyHandlers(
        { ...mainWindow, webContents: secondary } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { reuseRegisteredState: true }
      )

      expect(onMock.mock.calls).toHaveLength(ipcListenerCountBeforePromotion)
      expect(getPtyRendererDeliveryDebugSnapshot().rendererInFlightChars).toBe(14)
      ackBeforePromotion(foreignWindowIpcEvent, { id: result.id, processedChars: 14 })
      expect(getPtyRendererDeliveryDebugSnapshot().rendererInFlightChars).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores dispatcher readiness queued by a superseded main frame', async () => {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const handleRendererLoading = getMainFrameNavigationListener()
    const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()

    handleRendererLoading()
    handleRendererDispatcherReady({
      sender: mainWindow.webContents,
      senderFrame: { generation: 'old' }
    })
    expect(ptyRendererOwners.isDispatcherReadyFor(result.id)).toBe(false)

    handleRendererDispatcherReady(mainWindowIpcEvent)
    expect(ptyRendererOwners.isDispatcherReadyFor(result.id)).toBe(true)
  })

  it('reports delivery pressure only for the requesting renderer owner', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const secondProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc).mockReturnValueOnce(secondProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
        cols: 80,
        rows: 24
      })
      const second = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
        cols: 80,
        rows: 24
      })) as { id: string }
      const secondary = foreignWindowIpcEvent.sender
      registerPtyRenderer(secondary as never)
      ptyRendererOwners.markDispatcherReady(secondary as never)
      ptyRendererOwners.handoff([second.id], mainWindow.webContents as never, secondary as never)

      firstProc.emitData('primary-output')
      secondProc.emitData('secondary-output')
      vi.advanceTimersByTime(2)

      expect(
        handlers.get('pty:reportRendererDeliveryState')!(foreignWindowIpcEvent, {
          processedCharsByPty: {},
          receivedCharsByPty: {}
        })
      ).toMatchObject({
        inFlightTotalChars: 'secondary-output'.length,
        inFlightPtyCount: 1
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects global delivery debug and session inventory from an obsolete frame', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, { cols: 80, rows: 24 })
      const secondary = foreignWindowIpcEvent.sender
      registerPtyRenderer(secondary as never)
      mockProc.emitData('guarded-output')
      vi.advanceTimersByTime(2)
      const obsoleteFrameEvent = { sender: secondary, senderFrame: {} }

      expect(
        handlers.get('pty:getRendererDeliveryDebugSnapshot')!(obsoleteFrameEvent, {})
      ).toMatchObject({ rendererInFlightChars: 0 })
      handlers.get('pty:resetRendererDeliveryDebug')!(obsoleteFrameEvent, {})
      expect(
        handlers.get('pty:getRendererDeliveryDebugSnapshot')!(mainWindowIpcEvent, {})
      ).toMatchObject({ rendererInFlightChars: 'guarded-output'.length })
      await expect(handlers.get('pty:listSessions')!(obsoleteFrameEvent, {})).resolves.toEqual([])
      await expect(handlers.get('pty:listSessions')!(mainWindowIpcEvent, {})).resolves.not.toEqual(
        []
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('batches PTY output when it is not responding to recent input', async () => {
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
      mainWindow.webContents.send.mockClear()

      mockProc.emitData('background output')

      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'background output'
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('preserves background-origin metadata when hidden output flushes after resume', async () => {
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
      const setRendererPtyVisible = getPtySetRendererPtyVisibleListener()
      mainWindow.webContents.send.mockClear()

      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      mockProc.emitData('visible output')
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'visible output'
      })

      mainWindow.webContents.send.mockClear()
      setRendererPtyVisible(null, { id: spawnResult.id, visible: false })
      mockProc.emitData('\x1b[2Khidden-width redraw')
      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: '\x1b[2Khidden-width redraw',
        background: true
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('marks visible renderer PTYs hidden while the renderer lifecycle resets', async () => {
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
      const setRendererPtyVisible = getPtySetRendererPtyVisibleListener()
      const handleRendererLoading = getMainFrameNavigationListener()
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      mainWindow.webContents.send.mockClear()

      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      handleRendererLoading()
      // Reloaded page's dispatcher re-registers, releasing held sends (§1b).
      handleRendererDispatcherReady()
      mockProc.emitData('reload-gap output')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'reload-gap output',
        background: true
      })

      mainWindow.webContents.send.mockClear()
      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      mockProc.emitData('visible output')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'visible output'
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('resets leaked delivery accounting on renderer lifecycle reset so a saturated PTY resumes', async () => {
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
      const handleRendererLoading = getMainFrameNavigationListener()
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      // Drain the initial dispatcher-ready flush (beforeEach fires the handshake to model a live page) so flood timing starts clean.
      vi.advanceTimersByTime(1)
      mainWindow.webContents.send.mockClear()

      // Saturate the PTY past the 512 KB per-PTY high-water with no ACKs.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 31; index++) {
        vi.advanceTimersByTime(1)
      }

      // Gate closed: sends stop at the cap and the remainder accrues as pending.
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)
      vi.advanceTimersByTime(1)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)
      expect(vi.getTimerCount()).toBe(0)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024,
        pendingChars: 88 * 1024,
        pendingPtyCount: 1,
        rendererLifecycleResetCount: 0,
        lastLifecycleResetClearedChars: 0
      })

      // Renderer reload: the dead page never ACKs, so its in-flight/pending accounting must clear or the surviving PTY stays gated forever.
      handleRendererLoading()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        rendererInFlightPtyCount: 0,
        pendingChars: 0,
        pendingPtyCount: 0,
        rendererLifecycleResetCount: 1,
        lastLifecycleResetClearedChars: 512 * 1024
      })

      // Boot window (§1b): dispatcher not re-registered, so sends must be held — bytes into the listener-less page drop yet count in-flight, re-pinning the gate.
      mainWindow.webContents.send.mockClear()
      mockProc.emitData('post-reload output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: 'post-reload output'.length,
        pendingPtyCount: 1
      })

      // The dispatcher-ready handshake releases the held backlog; assert delivery actually resumes and pending drains, not just counters-zero.
      handleRendererDispatcherReady()
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-reload output'
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 'post-reload output'.length,
        pendingChars: 0,
        pendingPtyCount: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('ignores overlapping subframe navigation so an in-page iframe cannot reclose delivery', async () => {
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
      const handleRendererNavigation = getMainWindowWebContentsListener('did-start-navigation')
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      // Drain the initial dispatcher-ready flush (beforeEach fires the handshake).
      vi.advanceTimersByTime(1)
      mainWindow.webContents.send.mockClear()

      // Saturate the PTY past the 512 KB per-PTY high-water with no ACKs.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 31; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)

      // Main navigation closes the gate; the fresh dispatcher reopens it before an overlapping iframe navigates.
      handleRendererNavigation({ isMainFrame: true, isSameDocument: false })
      handleRendererDispatcherReady()
      handleRendererNavigation({ isMainFrame: false, isSameDocument: false })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: 0,
        pendingPtyCount: 0,
        rendererLifecycleResetCount: 1,
        lastLifecycleResetClearedChars: 512 * 1024,
        rendererPtyDispatcherReady: true
      })

      // Gate remains open: output after the iframe navigation reaches the fresh page without waiting for the watchdog.
      mainWindow.webContents.send.mockClear()
      mockProc.emitData('post-subframe output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-subframe output'
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: true,
        rendererDispatcherReadyForcedCount: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('reconciles stale delivery accounting when a fresh dispatcher-ready handshake arrives while the gate is still open (missed lifecycle reset)', async () => {
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
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      const ackData = getPtyAckDataListener()
      // Drain the initial dispatcher-ready flush (beforeEach fires the handshake).
      vi.advanceTimersByTime(1)
      mainWindow.webContents.send.mockClear()

      // Saturate the PTY past the 512 KB per-PTY high-water with no ACKs.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 31; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024,
        pendingChars: 88 * 1024,
        rendererLifecycleResetCount: 0,
        rendererPtyDispatcherReady: true
      })

      // A handshake from a new current main frame proves a missed lifecycle reset; reconcile or survivors stay pinned at the cap.
      mainWindow.webContents.send.mockClear()
      const replacementFrame = {}
      mainWindow.webContents.mainFrame = replacementFrame
      handleRendererDispatcherReady({
        sender: mainWindow.webContents,
        senderFrame: replacementFrame
      })
      const reconciled = getPtyRendererDeliveryDebugSnapshot()
      expect(reconciled).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: 0,
        pendingPtyCount: 0,
        rendererLifecycleResetCount: 1,
        rendererPtyDispatcherReady: true
      })
      expect(reconciled.lastLifecycleResetClearedChars).toBeGreaterThan(0)

      // Delivery has resumed: fresh output flows immediately instead of piling up behind the stale cap.
      mockProc.emitData('post-reconcile output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-reconcile output'
      })

      // A straggler ACK from the dead page cannot credit bytes delivered to the replacement frame.
      ackData(mainWindowIpcEvent, { id: spawnResult.id, charCount: 512 * 1024 })
      expect(getPtyRendererDeliveryDebugSnapshot().rendererInFlightChars).toBe(
        'post-reconcile output'.length
      )
    } finally {
      vi.useRealTimers()
    }
  })
  it('holds interactive input echo during the boot window until the dispatcher-ready handshake', async () => {
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
      const handleRendererLoading = getMainFrameNavigationListener()
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      const writeListener = getPtyWriteListener()
      // Drain the initial ready-flush the beforeEach handshake schedules.
      vi.advanceTimersByTime(1)

      // Reload closes the gate; the reloaded page's dispatcher has not re-registered.
      handleRendererLoading()
      mainWindow.webContents.send.mockClear()

      // With shouldSendInteractiveOutputNow() true, only the `&& rendererPtyDispatcherReady` guard keeps the interactive echo out of the still-listener-less page.
      const redraw = '\x1b[20;2Hredraw'
      writeListener(mainWindowIpcEvent, { id: spawnResult.id, data: 'a' })
      mockProc.emitData(redraw)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: redraw.length,
        pendingPtyCount: 1
      })

      // The handshake releases the held echo (drained via the batch flush).
      handleRendererDispatcherReady()
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: redraw
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('force-opens the delivery gate if no dispatcher-ready handshake arrives after a reload', async () => {
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
      const handleRendererLoading = getMainFrameNavigationListener()
      vi.advanceTimersByTime(1)

      // Reload closes the gate and arms the ~10s watchdog; the reloaded page never sends the handshake (dropped IPC), so output stays held.
      handleRendererLoading()
      mainWindow.webContents.send.mockClear()
      mockProc.emitData('post-reload output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: false,
        rendererDispatcherReadyForcedCount: 0
      })

      // Past the 10s watchdog window the gate self-heals (ready forced, backlog drains) instead of freezing permanently.
      vi.advanceTimersByTime(10_000)
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-reload output'
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: true,
        rendererDispatcherReadyForcedCount: 1
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
