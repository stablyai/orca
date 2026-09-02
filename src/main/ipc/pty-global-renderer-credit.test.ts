import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
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
    createMockProc,
    getPtyAckDataListener,
    getPtySetActiveRendererPtyListener,
    getPtySetHiddenRendererPtyListener,
    getPtySetDeliveryInterestListener,
    getPtyDataSendCalls
  } = setupPtyIpcSuite()

  it('wakes blocked PTYs when a zero-write hidden drop reentrantly releases exit credit', async () => {
    vi.useFakeTimers()
    const bulkProcs = Array.from({ length: 16 }, () => createMockProc())
    const hiddenProc = createMockProc()
    const heldProc = createMockProc()
    for (const proc of [...bulkProcs, hiddenProc, heldProc]) {
      spawnMock.mockReturnValueOnce(proc.proc)
    }

    try {
      registerPtyHandlers(mainWindow as never)
      const bulkSpawns: { id: string }[] = []
      for (const _proc of bulkProcs) {
        bulkSpawns.push(
          (await handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            cwd: '/tmp'
          })) as { id: string }
        )
      }
      const hiddenSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })

      for (const proc of bulkProcs) {
        proc.emitData('x'.repeat(600 * 1024))
      }
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 8 * 1024 * 1024,
        flushScheduled: false
      })

      const setHidden = getPtySetHiddenRendererPtyListener()
      const setInterest = getPtySetDeliveryInterestListener()
      setHidden(null, { id: hiddenSpawn.id, hidden: true })
      setInterest(null, { id: hiddenSpawn.id, interested: true })
      hiddenProc.emitData('drop-without-write')
      heldProc.emitData('held')
      setInterest(null, { id: hiddenSpawn.id, interested: false })
      mainWindow.webContents.send.mockClear()
      let reentered = false
      mainWindow.webContents.send.mockImplementation(
        (channel: string, payload: { id?: string }) => {
          if (channel === 'pty:modelRestoreNeeded' && payload.id === hiddenSpawn.id && !reentered) {
            reentered = true
            bulkProcs[0]!.emitExit(0)
          }
        }
      )

      vi.advanceTimersByTime(2)

      const exitIndex = mainWindow.webContents.send.mock.calls.findIndex(
        (call) => call[0] === 'pty:exit'
      )
      expect(exitIndex).toBeGreaterThanOrEqual(0)
      expect(getPtyRendererDeliveryDebugSnapshot().flushScheduled).toBe(true)
      vi.advanceTimersByTime(1)
      expect(
        mainWindow.webContents.send.mock.calls
          .slice(exitIndex + 1)
          .some(
            (call) =>
              call[0] === 'pty:data' &&
              (call[1] as { id?: string } | undefined)?.id !== bulkSpawns[0]!.id
          )
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not reactivate globally blocked PTYs when exit releases no prior credit', async () => {
    vi.useFakeTimers()
    const bulkProcs = Array.from({ length: 16 }, () => createMockProc())
    const finalProc = createMockProc()
    const heldProc = createMockProc()
    for (const proc of [...bulkProcs, finalProc, heldProc]) {
      spawnMock.mockReturnValueOnce(proc.proc)
    }

    try {
      registerPtyHandlers(mainWindow as never)
      for (const _proc of bulkProcs) {
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })
      }
      const finalSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string; incarnationId: string }
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })

      for (const proc of bulkProcs) {
        proc.emitData('x'.repeat(600 * 1024))
      }
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 8 * 1024 * 1024,
        flushScheduled: false
      })

      finalProc.emitData('final-tail')
      heldProc.emitData('held')
      vi.advanceTimersByTime(2)
      expect(getPtyRendererDeliveryDebugSnapshot().flushScheduled).toBe(false)
      const timerCountBeforeExit = vi.getTimerCount()
      mainWindow.webContents.send.mockClear()

      finalProc.emitExit(0)

      expect(mainWindow.webContents.send.mock.calls).toEqual([
        ['pty:data', { id: finalSpawn.id, data: 'final-tail' }],
        ['pty:exit', { id: finalSpawn.id, code: 0, incarnationId: finalSpawn.incarnationId }]
      ])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 8 * 1024 * 1024,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(timerCountBeforeExit)
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not schedule a teardown-only flush for the last active blocked PTY', async () => {
    vi.useFakeTimers()
    const proc = createMockProc()
    spawnMock.mockReturnValue(proc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      getPtySetActiveRendererPtyListener()(null, { id: spawn.id, active: true })
      proc.emitData('x'.repeat(1200 * 1024))
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 80; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)

      proc.emitExit(0)

      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('prioritizes active PTY pending output during renderer backpressure', async () => {
    vi.useFakeTimers()
    const procs = Array.from({ length: 18 }, () => createMockProc())
    for (const proc of procs) {
      spawnMock.mockReturnValueOnce(proc.proc)
    }

    try {
      registerPtyHandlers(mainWindow as never)
      const spawns: { id: string }[] = []
      for (const _proc of procs) {
        spawns.push(
          (await handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            cwd: '/tmp'
          })) as { id: string }
        )
      }
      const ackData = getPtyAckDataListener()
      const setActiveRendererPty = getPtySetActiveRendererPtyListener()
      mainWindow.webContents.send.mockClear()

      for (let index = 0; index < procs.length - 1; index++) {
        procs[index]!.emitData('x'.repeat(600 * 1024))
      }
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(512)

      const activeIndex = procs.length - 1
      procs[activeIndex]!.emitData('active-output')
      setActiveRendererPty(null, { id: spawns[activeIndex]!.id, active: true })
      vi.advanceTimersByTime(2)

      // Why: the fully gated arrival also emits a delivery resync probe, so count pty:data sends not raw webContents.send.
      expect(getPtyDataSendCalls()).toHaveLength(513)
      expect(getPtyDataSendCalls()[512]).toEqual([
        'pty:data',
        {
          id: spawns[activeIndex]!.id,
          data: 'active-output'
        }
      ])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        activeRendererPtyCount: 1,
        pendingPtyCount: procs.length - 1,
        rendererInFlightChars: 8 * 1024 * 1024 + 'active-output'.length
      })
      ackData(null, { id: spawns[0]!.id, charCount: 16 * 1024 })
    } finally {
      vi.useRealTimers()
    }
  })
  it('lets active PTY output exceed its old background in-flight cap', async () => {
    vi.useFakeTimers()
    const activeProc = createMockProc()
    spawnMock.mockReturnValue(activeProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const activeSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const setActiveRendererPty = getPtySetActiveRendererPtyListener()
      mainWindow.webContents.send.mockClear()

      activeProc.emitData('x'.repeat(768 * 1024))
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 31; index++) {
        vi.advanceTimersByTime(1)
      }

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 256 * 1024,
        rendererInFlightChars: 512 * 1024,
        maxRendererInFlightCharsByPty: 512 * 1024
      })

      setActiveRendererPty(null, { id: activeSpawn.id, active: true })
      vi.advanceTimersByTime(1)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(33)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(33, 'pty:data', {
        id: activeSpawn.id,
        data: 'x'.repeat(16 * 1024)
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingChars: 240 * 1024,
        rendererInFlightChars: 528 * 1024,
        maxRendererInFlightCharsByPty: 528 * 1024
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
