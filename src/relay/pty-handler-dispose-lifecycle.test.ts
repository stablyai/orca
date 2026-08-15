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

import { IMMEDIATE_PTY_EXIT_TIMEOUT_MS, type PtyHandler } from './pty-handler'
import { beginPtyHandlerTest, endPtyHandlerTest } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

describe('PtyHandler', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

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

  it('invokes the exit listener with the spawn-time paneKey', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    })

    const exits: { id: string; paneKey?: string }[] = []
    handler.setExitListener((evt) => exits.push(evt))

    await dispatcher.callRequest('pty.spawn', {
      env: { ORCA_PANE_KEY: 'tab-2:1' }
    })
    expect(onExitCb).toBeDefined()
    onExitCb!({ exitCode: 0 })

    expect(exits).toEqual([{ id: 'pty-1', paneKey: 'tab-2:1' }])
  })

  it('keeps immediate shutdown pending until onExit and invokes the exit listener once', async () => {
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

    await dispatcher.callRequest('pty.spawn', {
      env: { ORCA_PANE_KEY: 'tab-shutdown:0' }
    })
    let settled = false
    const shutdown = dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
    void shutdown.then(() => {
      settled = true
    })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(exits).toEqual([])
    expect(handler.activePtyCount).toBe(1)
    onExitCb!({ exitCode: 0 })
    await shutdown

    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
    expect(exits).toEqual([{ id: 'pty-1', paneKey: 'tab-shutdown:0' }])
    expect(handler.activePtyCount).toBe(0)
  })

  it('physically stops only matching worktree PTYs before relay deletion', async () => {
    let firstExit: ((evt: { exitCode: number }) => void) | undefined
    let secondExit: ((evt: { exitCode: number }) => void) | undefined
    const firstKill = vi.fn()
    const secondKill = vi.fn()
    mockPtySpawn
      .mockReturnValueOnce({
        ...mockPtyInstance,
        kill: firstKill,
        onData: vi.fn(),
        onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
          firstExit = cb
        })
      })
      .mockReturnValueOnce({
        ...mockPtyInstance,
        kill: secondKill,
        onData: vi.fn(),
        onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
          secondExit = cb
        })
      })

    await dispatcher.callRequest('pty.spawn', {
      cwd: '/repo',
      env: { ORCA_WORKTREE_ID: 'repo-id::/repo' }
    })
    await dispatcher.callRequest('pty.spawn', {
      cwd: '/sibling',
      env: { ORCA_WORKTREE_ID: 'repo-id::/sibling' }
    })

    let settled = false
    const shutdown = handler.shutdownForWorktreePath('/repo').finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(firstKill).toHaveBeenCalledWith('SIGKILL')
    expect(secondKill).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    expect(handler.activePtyCount).toBe(2)

    firstExit?.({ exitCode: 137 })
    await shutdown
    expect(secondExit).toBeDefined()
    expect(handler.activePtyCount).toBe(1)
  })

  it('rejects timed-out immediate shutdown while retaining the physical owner', async () => {
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
    const rejected = expect(shutdown).rejects.toThrow('Timed out waiting for PTY process exit')
    await vi.advanceTimersByTimeAsync(IMMEDIATE_PTY_EXIT_TIMEOUT_MS)
    await rejected

    expect(mockKill).toHaveBeenCalledTimes(1)
    expect(handler.activePtyCount).toBe(1)
    const retry = dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
    expect(mockKill).toHaveBeenCalledTimes(1)
    onExitCb!({ exitCode: 137 })
    await retry
    expect(handler.activePtyCount).toBe(0)
  })

  it('fences late creation and drains an admitted spawn before the disposal snapshot', async () => {
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

    const admittedSpawn = dispatcher.callRequest('pty.spawn', {})
    const dispose = handler.dispose()
    await admittedSpawn

    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
    expect(handler.activePtyCount).toBe(1)
    await expect(dispatcher.callRequest('pty.spawn', {})).rejects.toThrow(
      'PTY handler is shutting down'
    )
    const aliveSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await expect(
        dispatcher.callRequest('pty.revive', {
          state: JSON.stringify([
            { id: 'pty-late', pid: process.pid, cols: 80, rows: 24, cwd: '/tmp' }
          ])
        })
      ).rejects.toThrow('PTY handler is shutting down')
    } finally {
      aliveSpy.mockRestore()
    }

    onExitCb!({ exitCode: 137 })
    await dispose
    expect(handler.activePtyCount).toBe(0)
    expect(handler.dispose()).toBe(dispose)
  })

  it('retries a rejected force kill during dispose and waits for physical exit', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    let forceAttempts = 0
    const mockKill = vi.fn((signal: string) => {
      if (signal === 'SIGKILL' && forceAttempts++ === 0) {
        throw new Error('transient dispose kill failure')
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
    const dispose = handler.dispose()
    await Promise.resolve()

    expect(mockKill.mock.calls).toEqual([['SIGKILL']])
    expect(handler.activePtyCount).toBe(1)
    await vi.advanceTimersByTimeAsync(250)
    expect(mockKill.mock.calls).toEqual([['SIGKILL'], ['SIGKILL']])
    expect(handler.activePtyCount).toBe(1)

    onExitCb!({ exitCode: 137 })
    await dispose
    expect(handler.activePtyCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes ownership when dispose overlaps a queued graceful force-kill retry', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    let forceAttempts = 0
    const mockKill = vi.fn((signal: string) => {
      if (signal === 'SIGKILL' && forceAttempts++ < 2) {
        throw new Error('transient overlapping kill failure')
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
    expect(vi.getTimerCount()).toBe(1)

    const dispose = handler.dispose()
    await Promise.resolve()
    expect(mockKill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGKILL']])
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(250)
    expect(mockKill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGKILL'], ['SIGKILL']])
    expect(handler.activePtyCount).toBe(1)

    onExitCb!({ exitCode: 137 })
    await dispose
    expect(handler.activePtyCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose kills all PTYs with SIGKILL and invokes exit listeners', async () => {
    const mockKill = vi.fn()
    const onExitCallbacks: ((evt: { exitCode: number }) => void)[] = []
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCallbacks.push(cb)
      })
    })
    const exits: { id: string; paneKey?: string }[] = []
    handler.setExitListener((evt) => exits.push(evt))

    await dispatcher.callRequest('pty.spawn', { env: { ORCA_PANE_KEY: 'tab-dispose:0' } })
    await dispatcher.callRequest('pty.spawn', { env: { ORCA_PANE_KEY: 'tab-dispose:1' } })
    expect(handler.activePtyCount).toBe(2)

    const dispose = handler.dispose()
    await Promise.resolve()
    // Why: dispose uses SIGKILL (not SIGTERM) because the relay process is
    // exiting. A SIGTERM-ignoring remote shell (editor with unsaved buffers,
    // wedged process, uninterruptible sleep) would survive SIGTERM + immediate
    // destroy() as an orphan on the remote host. SIGKILL is not ignorable.
    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
    expect(handler.activePtyCount).toBe(2)
    for (const onExit of onExitCallbacks) {
      onExit({ exitCode: 137 })
    }
    await dispose
    expect(exits).toEqual([
      { id: 'pty-1', paneKey: 'tab-dispose:0' },
      { id: 'pty-2', paneKey: 'tab-dispose:1' }
    ])
    expect(handler.activePtyCount).toBe(0)
  })
})
