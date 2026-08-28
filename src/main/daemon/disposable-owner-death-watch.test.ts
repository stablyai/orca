import { describe, expect, it, vi } from 'vitest'
import { DisposableOwnerDeathWatch } from './disposable-owner-death-watch'

function esrch(): never {
  throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
}

describe('a disposable daemon retires with its owner', () => {
  it('NEGATIVE CONTROL: retires when the owner is gone, even with no graceful quit', async () => {
    // The incident: candidate apps went away without running a quit path, and
    // their daemons — holding every supervised agent session — stayed up while
    // the state root was deleted out from under them.
    const onRetire = vi.fn()
    const watch = new DisposableOwnerDeathWatch({
      ownerPid: 4242,
      ownerStartedAtMs: 1,
      onRetire,
      probe: esrch
    })
    await watch.check()
    expect(onRetire).toHaveBeenCalledWith({ ownerPid: 4242, cause: 'owner-exited' })
  })

  it('retires exactly once', async () => {
    const onRetire = vi.fn()
    const watch = new DisposableOwnerDeathWatch({
      ownerPid: 4242,
      ownerStartedAtMs: 1,
      onRetire,
      probe: esrch
    })
    await watch.check()
    await watch.check()
    expect(onRetire).toHaveBeenCalledTimes(1)
  })

  it('does not retire while the owner is alive', async () => {
    const onRetire = vi.fn()
    await new DisposableOwnerDeathWatch({
      ownerPid: process.pid,
      ownerStartedAtMs: 10,
      onRetire,
      readStartedAtMs: async () => 10
    }).check()
    expect(onRetire).not.toHaveBeenCalled()
  })

  it('does not retire on EPERM or on an unknown probe failure', async () => {
    for (const code of ['EPERM', undefined]) {
      const onRetire = vi.fn()
      await new DisposableOwnerDeathWatch({
        ownerPid: 1,
        ownerStartedAtMs: 1,
        onRetire,
        probe: () => {
          throw Object.assign(new Error('nope'), code ? { code } : {})
        }
      }).check()
      expect(onRetire).not.toHaveBeenCalled()
    }
  })

  it('polls on an unref-ed timer and stops cleanly', () => {
    const unref = vi.fn()
    const timer = { unref } as unknown as ReturnType<typeof setInterval>
    const setIntervalMock = vi.fn(() => timer) as unknown as typeof setInterval
    const clearIntervalMock = vi.fn() as unknown as typeof clearInterval
    const watch = new DisposableOwnerDeathWatch({
      ownerPid: 4242,
      ownerStartedAtMs: 1,
      onRetire: vi.fn(),
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock
    })
    watch.start()
    watch.start()
    expect(setIntervalMock).toHaveBeenCalledTimes(1)
    expect(unref).toHaveBeenCalled()
    watch.stop()
    expect(clearIntervalMock).toHaveBeenCalledWith(timer)
  })

  it('rejects a reused PID with a different process incarnation', async () => {
    const onRetire = vi.fn()
    const watch = new DisposableOwnerDeathWatch({
      ownerPid: 4242,
      ownerStartedAtMs: 1_000,
      onRetire,
      probe: () => undefined,
      readStartedAtMs: async () => 9_000
    })
    await watch.check()
    expect(onRetire).toHaveBeenCalledWith({
      ownerPid: 4242,
      cause: 'owner-incarnation-changed'
    })
  })

  it('fails closed and remains re-entrant when start-time inspection throws', async () => {
    const onRetire = vi.fn()
    const watch = new DisposableOwnerDeathWatch({
      ownerPid: 4242,
      ownerStartedAtMs: 1_000,
      onRetire,
      probe: () => undefined,
      readStartedAtMs: async () => {
        throw new Error('inspection failed')
      }
    })
    await watch.check()
    await watch.check()
    expect(onRetire).toHaveBeenCalledTimes(1)
    expect(onRetire).toHaveBeenCalledWith({
      ownerPid: 4242,
      cause: 'owner-incarnation-unverifiable'
    })
  })
})
