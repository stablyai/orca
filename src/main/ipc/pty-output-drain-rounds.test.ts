import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  registerPtyHandlers,
  getPtyRendererDeliveryDebugSnapshot,
  resetPtyRendererDeliveryDebug
} from './pty'

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
    createMockProc,
    installObservableDaemonTestProvider,
    getPtyAckDataListener,
    getPtySetActiveRendererPtyListener,
    getMainFrameNavigationListener,
    getPtyDataSendCalls
  } = setupPtyIpcSuite()

  it('drains large batched PTY output in bounded slices', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const secondProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc).mockReturnValueOnce(secondProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const firstSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const secondSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      mainWindow.webContents.send.mockClear()

      const firstChunk = 'x'.repeat(16 * 1024)
      const firstRemainder = 'tail'
      secondProc.emitData('second-terminal-output')
      firstProc.emitData(`${firstChunk}${firstRemainder}`)

      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(2)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(1, 'pty:data', {
        id: secondSpawn.id,
        data: 'second-terminal-output'
      })
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(2, 'pty:data', {
        id: firstSpawn.id,
        data: firstChunk
      })

      vi.advanceTimersByTime(1)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(3)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(3, 'pty:data', {
        id: firstSpawn.id,
        data: firstRemainder
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('defers reentrant new, unvisited, and same-partial output to the next drain round', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const secondProc = createMockProc()
    const newProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc)
    spawnMock.mockReturnValueOnce(secondProc.proc)
    spawnMock.mockReturnValueOnce(newProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const firstSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const secondSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const newSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const firstChunk = 'x'.repeat(16 * 1024)
      const setActiveRendererPty = getPtySetActiveRendererPtyListener()
      let reentered = false
      mainWindow.webContents.send.mockImplementation(
        (channel: string, payload: { id?: string }) => {
          if (channel !== 'pty:data' || payload.id !== firstSpawn.id || reentered) {
            return
          }
          reentered = true
          firstProc.emitData('+same')
          secondProc.emitData('+append')
          newProc.emitData('new')
          setActiveRendererPty(null, { id: newSpawn.id, active: true })
        }
      )

      firstProc.emitData(`${firstChunk}tail`)
      secondProc.emitData('second')
      vi.advanceTimersByTime(2)
      expect(getPtyDataSendCalls()).toEqual([['pty:data', { id: firstSpawn.id, data: firstChunk }]])

      vi.advanceTimersByTime(2)
      expect(getPtyDataSendCalls().slice(1)).toEqual([
        ['pty:data', { id: newSpawn.id, data: 'new' }],
        ['pty:data', { id: secondSpawn.id, data: 'second+append' }]
      ])

      vi.advanceTimersByTime(1)
      expect(getPtyDataSendCalls().at(-1)).toEqual([
        'pty:data',
        { id: firstSpawn.id, data: 'tail+same' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })
  it('commits a partial remainder before notification-reentrant exit', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const secondProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc).mockReturnValueOnce(secondProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const firstSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string; incarnationId: string }
      const secondSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const firstChunk = 'x'.repeat(16 * 1024)
      mainWindow.webContents.send.mockClear()
      let exited = false
      mainWindow.webContents.send.mockImplementation(
        (channel: string, payload: { id?: string; data?: string }) => {
          if (
            channel === 'pty:data' &&
            payload.id === firstSpawn.id &&
            payload.data === firstChunk &&
            !exited
          ) {
            exited = true
            firstProc.emitExit(0)
          }
        }
      )

      firstProc.emitData(`${firstChunk}tail`)
      secondProc.emitData('next')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send.mock.calls).toEqual([
        ['pty:data', { id: firstSpawn.id, data: firstChunk }],
        ['pty:data', { id: firstSpawn.id, data: 'tail' }],
        ['pty:exit', { id: firstSpawn.id, code: 0, incarnationId: firstSpawn.incarnationId }],
        ['pty:data', { id: secondSpawn.id, data: 'next' }]
      ])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        rendererInFlightPtyCount: 1,
        rendererInFlightChars: 'next'.length,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('aborts the open drain when renderer lifecycle clear reenters notification', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const detachedProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc).mockReturnValueOnce(detachedProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const firstSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })
      const handleRendererLoading = getMainFrameNavigationListener()
      let cleared = false
      mainWindow.webContents.send.mockImplementation(
        (channel: string, payload: { id?: string }) => {
          if (channel === 'pty:data' && payload.id === firstSpawn.id && !cleared) {
            cleared = true
            handleRendererLoading()
          }
        }
      )

      firstProc.emitData('first')
      detachedProc.emitData('must-not-send')
      vi.advanceTimersByTime(2)

      expect(getPtyDataSendCalls()).toEqual([['pty:data', { id: firstSpawn.id, data: 'first' }]])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0,
        flushScheduled: false,
        rendererPtyDispatcherReady: false
      })
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('waits for renderer ACKs before sending more output for a saturated PTY', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const secondProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc).mockReturnValueOnce(secondProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const firstSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const secondSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const ackData = getPtyAckDataListener()
      mainWindow.webContents.send.mockClear()

      firstProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 31; index++) {
        vi.advanceTimersByTime(1)
      }

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)
      vi.advanceTimersByTime(1)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)
      expect(vi.getTimerCount()).toBe(0)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 88 * 1024,
        maxPendingCharsByPty: 88 * 1024,
        rendererInFlightPtyCount: 1,
        rendererInFlightChars: 512 * 1024,
        maxRendererInFlightCharsByPty: 512 * 1024,
        flushScheduled: false,
        peakPendingChars: 600 * 1024,
        peakMaxPendingCharsByPty: 600 * 1024,
        peakRendererInFlightChars: 512 * 1024,
        peakMaxRendererInFlightCharsByPty: 512 * 1024,
        ackGatedFlushSkipCount: 1
      })

      secondProc.emitData('second-terminal-output')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(33)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(33, 'pty:data', {
        id: secondSpawn.id,
        data: 'second-terminal-output'
      })

      ackData(null, { id: firstSpawn.id, charCount: 16 * 1024 })
      vi.advanceTimersByTime(1)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(34)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(34, 'pty:data', {
        id: firstSpawn.id,
        data: 'x'.repeat(16 * 1024)
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 72 * 1024,
        rendererInFlightChars: 512 * 1024 + 'second-terminal-output'.length,
        peakPendingChars: 600 * 1024,
        peakRendererInFlightChars: 512 * 1024 + 'second-terminal-output'.length
      })

      resetPtyRendererDeliveryDebug()

      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 72 * 1024,
        rendererInFlightChars: 512 * 1024 + 'second-terminal-output'.length,
        peakPendingChars: 72 * 1024,
        peakMaxPendingCharsByPty: 72 * 1024,
        peakRendererInFlightChars: 512 * 1024 + 'second-terminal-output'.length,
        peakMaxRendererInFlightCharsByPty: 512 * 1024,
        ackGatedFlushSkipCount: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not scan delivery maps for 1,000 ACKs across 100 tracked PTYs', () => {
    vi.useFakeTimers()
    const provider = installObservableDaemonTestProvider()

    try {
      registerPtyHandlers(mainWindow as never)
      const ptyIds = Array.from({ length: 100 }, (_, index) => `pressure-pty-${index}`)
      for (const id of ptyIds) {
        provider.emitData(id, 'a')
      }
      vi.runAllTimers()
      for (const id of ptyIds) {
        provider.emitData(id, 'b')
      }
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 100,
        pendingChars: 100,
        rendererInFlightPtyCount: 100,
        rendererInFlightChars: 100
      })

      const ackData = getPtyAckDataListener()
      const mapValuesSpy = vi.spyOn(Map.prototype, 'values')
      let mapValuesCalls = 0
      try {
        for (let index = 0; index < 1_000; index++) {
          ackData(null, { id: ptyIds[0]!, processedChars: 1 })
        }
      } finally {
        mapValuesCalls = mapValuesSpy.mock.calls.length
        mapValuesSpy.mockRestore()
      }

      expect(mapValuesCalls).toBe(0)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 100,
        pendingChars: 100,
        rendererInFlightPtyCount: 99,
        rendererInFlightChars: 99
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
