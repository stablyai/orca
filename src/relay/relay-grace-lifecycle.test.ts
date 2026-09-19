import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayDispatcher } from './dispatcher'
import type { PtyHandler } from './pty-handler'
import { RelayGraceLifecycle } from './relay-grace-lifecycle'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture() {
  const events: string[] = []
  const stopEmpty = vi.fn(() => events.push('stop-empty'))
  const stopActive = vi.fn(() => events.push('stop-active'))
  const ptyHandler = {
    hasLiveOwnershipTransferFence: false,
    activePtyCount: 1,
    cancelGraceTimer: vi.fn(),
    setOwnershipTransferGraceGuardEnabled: vi.fn(),
    dispose: vi.fn(async () => {
      events.push('pty')
    }),
    onPtyPoolEmpty: vi.fn(() => stopEmpty),
    onPtyPoolActive: vi.fn(() => stopActive)
  }
  const disposeOwnedProcesses = vi.fn(async () => {
    events.push('owned')
  })
  const disposeRuntime = vi.fn()
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('Unexpected process exit')
  })
  vi.spyOn(process, 'on').mockImplementation(() => process)
  const beginWorkDrain = vi.fn(async () => {})
  const lifecycle = new RelayGraceLifecycle({
    dispatcher: {
      onRequest: vi.fn(),
      onNotification: vi.fn(),
      beginWorkDrain
    } as unknown as RelayDispatcher,
    ptyHandler: ptyHandler as unknown as PtyHandler,
    detached: true,
    emptyDetachedStartupGraceMs: 100,
    idleRelayGraceMs: 100,
    readSocketClientCount: () => 1,
    hasAcceptedSocketClient: () => true,
    ownsSocketPath: () => true,
    disposeOwnedProcesses,
    disposeRuntime
  })
  lifecycle.installProcessLifecycle()
  return {
    lifecycle,
    ptyHandler,
    disposeOwnedProcesses,
    disposeRuntime,
    exit,
    events,
    beginWorkDrain
  }
}

afterEach(() => vi.restoreAllMocks())

describe('RelayGraceLifecycle awaitable disposal', () => {
  it('reports admission only after transfer refusal checks and before mutation', async () => {
    const f = fixture()
    const admitted = vi.fn(() => {
      expect(f.ptyHandler.cancelGraceTimer).not.toHaveBeenCalled()
      expect(f.beginWorkDrain).not.toHaveBeenCalled()
    })
    f.ptyHandler.hasLiveOwnershipTransferFence = true
    await expect(f.lifecycle.prepareShutdown(undefined, admitted)).rejects.toThrow(
      'shutdown_fenced'
    )
    expect(admitted).not.toHaveBeenCalled()
    f.ptyHandler.hasLiveOwnershipTransferFence = false
    await f.lifecycle.prepareShutdown(undefined, admitted)
    await f.lifecycle.prepareShutdown(undefined, admitted)
    expect(admitted).toHaveBeenCalledOnce()
  })

  it('returns callback failure without mutation and permits retry', async () => {
    const f = fixture()
    await expect(
      f.lifecycle.prepareShutdown(undefined, () => {
        throw new Error('record failed')
      })
    ).rejects.toThrow('record failed')
    expect(f.ptyHandler.cancelGraceTimer).not.toHaveBeenCalled()
    expect(f.beginWorkDrain).not.toHaveBeenCalled()
    await f.lifecycle.prepareShutdown()
  })

  it('returns synchronous grace cancellation failure as an admitted retryable failure', async () => {
    const f = fixture()
    const admitted = vi.fn()
    f.ptyHandler.cancelGraceTimer.mockImplementationOnce(() => {
      throw new Error('cancel failed')
    })
    await expect(f.lifecycle.prepareShutdown(undefined, admitted)).rejects.toThrow('cancel failed')
    expect(admitted).toHaveBeenCalledOnce()
    expect(f.ptyHandler.dispose).not.toHaveBeenCalled()
    await f.lifecycle.prepareShutdown()
  })
  it('joins cleanup controls admitted while owned producers were settling', async () => {
    const f = fixture()
    const controls = deferred()
    f.beginWorkDrain.mockResolvedValueOnce(undefined).mockReturnValueOnce(controls.promise)
    const prepared = vi.fn()
    const preparation = f.lifecycle.prepareShutdown().then(prepared)
    await vi.waitFor(() => expect(f.beginWorkDrain).toHaveBeenCalledTimes(2))
    expect(f.disposeOwnedProcesses).toHaveBeenCalledOnce()
    expect(prepared).not.toHaveBeenCalled()
    expect(() => f.lifecycle.finishShutdown()).toThrow('relay_shutdown_preparation_required')
    controls.resolve()
    await preparation
  })

  it('fences dispatcher admission before PTY disposal and drains handlers before owned cleanup', async () => {
    const f = fixture()
    const work = deferred()
    f.beginWorkDrain.mockReturnValue(work.promise)
    f.ptyHandler.dispose.mockImplementation(async () => {
      expect(f.beginWorkDrain).toHaveBeenCalledOnce()
    })
    const preparation = f.lifecycle.prepareShutdown()
    expect(f.ptyHandler.dispose).toHaveBeenCalledOnce()
    await new Promise((resolve) => setImmediate(resolve))
    expect(f.disposeOwnedProcesses).not.toHaveBeenCalled()
    expect(() => f.lifecycle.finishShutdown()).toThrow('relay_shutdown_preparation_required')
    work.resolve()
    await preparation
    expect(f.disposeOwnedProcesses).toHaveBeenCalledOnce()
  })

  it('waits for admitted work even after synchronous PTY disposal failure', async () => {
    const f = fixture()
    const work = deferred()
    f.beginWorkDrain.mockReturnValue(work.promise)
    f.ptyHandler.dispose.mockImplementationOnce(() => {
      throw new Error('pty failed')
    })
    const settled = vi.fn()
    const preparation = f.lifecycle.prepareShutdown().catch(settled)
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).not.toHaveBeenCalled()
    work.resolve()
    await preparation
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ message: 'pty failed' }))
    expect(f.disposeOwnedProcesses).not.toHaveBeenCalled()
    await f.lifecycle.prepareShutdown()
    expect(f.disposeOwnedProcesses).toHaveBeenCalledOnce()
  })

  it('retains both drainage and PTY failures without acknowledging shutdown', async () => {
    const f = fixture()
    const workError = new Error('work failed')
    const ptyError = new Error('pty failed')
    f.beginWorkDrain.mockRejectedValueOnce(workError)
    f.ptyHandler.dispose.mockRejectedValueOnce(ptyError)
    await expect(f.lifecycle.prepareShutdown()).rejects.toMatchObject({
      message: 'relay_shutdown_admitted_work_incomplete',
      errors: [workError, ptyError]
    })
    expect(f.disposeOwnedProcesses).not.toHaveBeenCalled()
    expect(() => f.lifecycle.finishShutdown()).toThrow('relay_shutdown_preparation_required')
    await f.lifecycle.prepareShutdown()
  })

  it('starts PTY disposal synchronously and leaves watcher/runtime cleanup until finish', async () => {
    const f = fixture()
    const pty = deferred()
    const owned = deferred()
    f.ptyHandler.dispose.mockImplementation(() => {
      f.events.push('pty')
      return pty.promise
    })
    f.disposeOwnedProcesses.mockImplementation(() => {
      f.events.push('owned')
      return owned.promise
    })
    const operation = f.lifecycle.prepareShutdown()
    expect(f.events).toEqual(['pty'])
    pty.resolve()
    await pty.promise
    await vi.waitFor(() => expect(f.events).toEqual(['pty', 'owned']))
    owned.resolve()
    await operation
    expect(f.events).toEqual(['pty', 'owned'])
    expect(f.disposeRuntime).not.toHaveBeenCalled()
    expect(f.exit).not.toHaveBeenCalled()
    expect(() => f.lifecycle.finishShutdown()).toThrow('Unexpected process exit')
    expect(f.events).toEqual(['pty', 'owned', 'stop-empty', 'stop-active'])
    expect(f.disposeRuntime).toHaveBeenCalledTimes(1)
    expect(f.exit).toHaveBeenCalledWith(0)
  })

  it('joins pending disposal and retains successful completion without repeated cleanup', async () => {
    const f = fixture()
    const pending = deferred()
    f.ptyHandler.dispose.mockReturnValue(pending.promise)
    const first = f.lifecycle.prepareShutdown()
    expect(f.lifecycle.prepareShutdown()).toBe(first)
    pending.resolve()
    await first
    expect(f.lifecycle.prepareShutdown()).toBe(first)
    expect(f.ptyHandler.dispose).toHaveBeenCalledTimes(1)
    expect(f.disposeOwnedProcesses).toHaveBeenCalledTimes(1)
    expect(f.disposeRuntime).not.toHaveBeenCalled()
    expect(f.exit).not.toHaveBeenCalled()
  })

  it('refuses active transfers without cleanup and allows retry after release', async () => {
    const f = fixture()
    f.ptyHandler.hasLiveOwnershipTransferFence = true
    await expect(f.lifecycle.prepareShutdown()).rejects.toThrow(
      'pty_ownership_transfer_source_shutdown_fenced'
    )
    expect(f.ptyHandler.dispose).not.toHaveBeenCalled()
    expect(f.beginWorkDrain).not.toHaveBeenCalled()
    expect(f.ptyHandler.cancelGraceTimer).not.toHaveBeenCalled()
    expect(f.events).toEqual([])
    expect(f.disposeRuntime).not.toHaveBeenCalled()
    expect(f.exit).not.toHaveBeenCalled()
    f.ptyHandler.hasLiveOwnershipTransferFence = false
    await f.lifecycle.prepareShutdown()
    expect(f.events).toEqual(['pty', 'owned'])
  })

  it.each(['pty', 'owned'] as const)('allows retry after %s disposal rejects', async (stage) => {
    const f = fixture()
    const failing = stage === 'pty' ? f.ptyHandler.dispose : f.disposeOwnedProcesses
    failing.mockRejectedValueOnce(new Error(`${stage} failed`))
    const first = f.lifecycle.prepareShutdown()
    await expect(first).rejects.toThrow(`${stage} failed`)
    expect(f.events).not.toContain('stop-empty')
    expect(f.events).not.toContain('stop-active')
    const retry = f.lifecycle.prepareShutdown()
    expect(retry).not.toBe(first)
    await retry
    expect(f.events.slice(-2)).toEqual(['pty', 'owned'])
    expect(f.disposeRuntime).not.toHaveBeenCalled()
    expect(f.exit).not.toHaveBeenCalled()
  })

  it('refuses finish before preparation completes', async () => {
    const f = fixture()
    expect(() => f.lifecycle.finishShutdown()).toThrow('relay_shutdown_preparation_required')
    const pending = deferred()
    f.ptyHandler.dispose.mockReturnValue(pending.promise)
    const operation = f.lifecycle.prepareShutdown()
    expect(() => f.lifecycle.finishShutdown()).toThrow('relay_shutdown_preparation_required')
    expect(f.events).toEqual([])
    expect(f.disposeRuntime).not.toHaveBeenCalled()
    expect(f.exit).not.toHaveBeenCalled()
    pending.resolve()
    await operation
  })

  it('returns synchronous PTY disposal failure as a rejection and permits retry', async () => {
    const f = fixture()
    f.ptyHandler.dispose.mockImplementationOnce(() => {
      throw new Error('synchronous disposal failure')
    })
    await expect(f.lifecycle.prepareShutdown()).rejects.toThrow('synchronous disposal failure')
    expect(f.disposeOwnedProcesses).not.toHaveBeenCalled()
    expect(() => f.lifecycle.finishShutdown()).toThrow('relay_shutdown_preparation_required')
    await f.lifecycle.prepareShutdown()
    expect(f.events).toEqual(['pty', 'owned'])
    expect(f.disposeRuntime).not.toHaveBeenCalled()
    expect(f.exit).not.toHaveBeenCalled()
  })
})
