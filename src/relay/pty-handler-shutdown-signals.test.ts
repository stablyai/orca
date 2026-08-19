import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    // Why: attach now proves the backing pid is alive before replaying, so the
    // default managed PTY must report a live pid. Reuse the test runner's own
    // pid — always alive — so unrelated attach tests are not seen as dead.
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

describe('PtyHandler', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  const { spawnPty } = createPtyRequestHelpers(() => dispatcher)

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('terminates spawned PTY when request becomes stale before response', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    const killSpy = vi.fn()
    const term = {
      ...mockPtyInstance,
      kill: killSpy,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    }
    mockPtySpawn.mockReturnValue(term)

    await dispatcher.callRequest(
      'pty.spawn',
      {},
      {
        isStale: () => mockPtySpawn.mock.calls.length > 0
      }
    )

    // Why: assert via the captured spy reference rather than term.kill because
    // disposeManagedPty() neutralizes managed.pty.kill (replaces it with a
    // no-op) on POSIX to close the UnixTerminal.destroy() → socket-close →
    // SIGHUP-to-recycled-pid race. After the 5s timer fires, term.kill is the
    // neutralized function, not the original spy. killSpy retains call history.
    expect(killSpy).toHaveBeenCalledWith('SIGTERM')
    vi.advanceTimersByTime(5000)
    expect(killSpy).toHaveBeenCalledWith('SIGKILL')
    expect(handler.activePtyCount).toBe(1)

    onExitCb?.({ exitCode: 137 })
    expect(handler.activePtyCount).toBe(0)
  })

  it('accepts SIGWINCH for restored TUI repaint', async () => {
    await dispatcher.callRequest('pty.spawn', {})

    await dispatcher.callRequest('pty.sendSignal', { id: 'pty-1', signal: 'SIGWINCH' })

    const term = mockPtySpawn.mock.results[0].value
    expect(term.kill).toHaveBeenCalledWith('SIGWINCH')
  })

  it('kills PTY on shutdown with SIGTERM by default', async () => {
    const mockKill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: false })
    expect(mockKill).toHaveBeenCalledWith('SIGTERM')
  })

  // Why: node-pty's Windows agent throws "Signals not supported on windows."
  // for any signal argument. killPtyProcess drops the signal on win32 — cover
  // every call site so a future regression cannot reintroduce signal args.
  describe('kills PTY without a signal on Windows', () => {
    async function withWindowsPlatform(fn: () => Promise<void>): Promise<void> {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      try {
        await fn()
      } finally {
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: originalPlatform
        })
      }
    }

    function mockKillablePty(): ReturnType<typeof vi.fn> {
      const mockKill = vi.fn()
      mockPtySpawn.mockReturnValue({
        ...mockPtyInstance,
        kill: mockKill,
        onData: vi.fn(),
        onExit: vi.fn()
      })
      return mockKill
    }

    function expectBareKills(mockKill: ReturnType<typeof vi.fn>, times: number): void {
      expect(mockKill).toHaveBeenCalledTimes(times)
      expect(mockKill.mock.calls.every((args) => args.length === 0)).toBe(true)
    }

    it('on graceful shutdown', async () => {
      await withWindowsPlatform(async () => {
        const mockKill = mockKillablePty()
        await dispatcher.callRequest('pty.spawn', {})
        await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: false })
        expectBareKills(mockKill, 1)
      })
    })

    it('on immediate shutdown', async () => {
      await withWindowsPlatform(async () => {
        let onExitCb: ((evt: { exitCode: number }) => void) | undefined
        const mockKill = vi.fn()
        mockPtySpawn.mockReturnValue({
          ...mockPtyInstance,
          kill: mockKill,
          onData: vi.fn(),
          onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
            onExitCb = cb
          })
        })
        await dispatcher.callRequest('pty.spawn', {})
        const shutdown = dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
        onExitCb!({ exitCode: 137 })
        await shutdown
        expectBareKills(mockKill, 1)
      })
    })

    it('does not double-kill when immediate cleanup joins graceful shutdown', async () => {
      await withWindowsPlatform(async () => {
        let onExitCb: ((evt: { exitCode: number }) => void) | undefined
        const mockKill = vi.fn()
        const destroy = vi.fn()
        mockPtySpawn.mockReturnValue({
          ...mockPtyInstance,
          kill: mockKill,
          destroy,
          onData: vi.fn(),
          onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
            onExitCb = cb
          })
        })
        await dispatcher.callRequest('pty.spawn', {})
        await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: false })
        const immediate = dispatcher.callRequest('pty.shutdown', {
          id: 'pty-1',
          immediate: true
        })

        expectBareKills(mockKill, 1)
        onExitCb!({ exitCode: 137 })
        await immediate
        expectBareKills(mockKill, 1)
        expect(destroy).not.toHaveBeenCalled()
      })
    })

    it('does not retry stale-spawn cleanup after the Windows kill deadline', async () => {
      await withWindowsPlatform(async () => {
        const mockKill = mockKillablePty()
        await dispatcher.callRequest(
          'pty.spawn',
          {},
          {
            isStale: () => mockPtySpawn.mock.calls.length > 0
          }
        )
        expectBareKills(mockKill, 1)
        vi.advanceTimersByTime(5000)
        expectBareKills(mockKill, 1)
      })
    })

    it('does not retry graceful shutdown after the Windows kill deadline', async () => {
      await withWindowsPlatform(async () => {
        const mockKill = mockKillablePty()
        await dispatcher.callRequest('pty.spawn', {})
        await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: false })
        expectBareKills(mockKill, 1)
        vi.advanceTimersByTime(5000)
        expectBareKills(mockKill, 1)
      })
    })

    it('on dispose', async () => {
      await withWindowsPlatform(async () => {
        const mockKill = vi.fn()
        const destroy = vi.fn()
        mockPtySpawn.mockReturnValue({
          ...mockPtyInstance,
          kill: mockKill,
          destroy,
          onData: vi.fn(),
          onExit: vi.fn()
        })
        await dispatcher.callRequest('pty.spawn', {})
        await handler.dispose({ waitForPhysicalExit: false })
        expectBareKills(mockKill, 1)
        expect(destroy).not.toHaveBeenCalled()
      })
    })
  })

  it('flushes pending PTY output before immediate shutdown cleanup', async () => {
    let dataCallback: ((data: string) => void) | undefined
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    const mockKill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    })

    await dispatcher.callRequest('pty.spawn', {})
    dataCallback!('last words')
    const shutdown = dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
    onExitCb!({ exitCode: 137 })
    await shutdown

    expect(dispatcher.notify).toHaveBeenNthCalledWith(1, 'pty.data', {
      id: 'pty-1',
      data: 'last words'
    })
    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
  })

  it('notifies pty.exit when graceful shutdown falls back to SIGKILL', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    const mockKill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    })
    const exits: { id: string; paneKey?: string }[] = []
    handler.setExitListener((evt) => exits.push(evt))

    const spawn = await spawnPty({ env: { ORCA_PANE_KEY: 'tab-fallback:0' } })
    await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: false })
    vi.advanceTimersByTime(5000)

    expect(handler.activePtyCount).toBe(1)
    expect(exits).toEqual([])
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.exit', expect.anything())
    onExitCb!({ exitCode: 137 })

    expect(mockKill).toHaveBeenCalledWith('SIGTERM')
    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.exit', {
      id: 'pty-1',
      code: 137,
      incarnationId: spawn.incarnationId
    })
    expect(exits).toEqual([{ id: 'pty-1', paneKey: 'tab-fallback:0' }])
    expect(handler.activePtyCount).toBe(0)
  })

  it('retries a rejected graceful SIGKILL fallback while retaining ownership', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    let forceAttempts = 0
    const mockKill = vi.fn((signal: string) => {
      if (signal === 'SIGKILL' && forceAttempts++ === 0) {
        throw new Error('transient kill failure')
      }
    })
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    })

    await dispatcher.callRequest('pty.spawn', {})
    await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: false })
    vi.advanceTimersByTime(5000)

    expect(mockKill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(handler.activePtyCount).toBe(1)
    expect(vi.getTimerCount()).toBe(1)

    vi.runOnlyPendingTimers()
    expect(mockKill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGKILL']])
    expect(handler.activePtyCount).toBe(1)

    onExitCb!({ exitCode: 137 })
    expect(handler.activePtyCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('kills PTY on shutdown with SIGKILL when immediate', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    const mockKill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    })

    await dispatcher.callRequest('pty.spawn', {})
    const shutdown = dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
    onExitCb!({ exitCode: 137 })
    await shutdown
    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
  })
})
