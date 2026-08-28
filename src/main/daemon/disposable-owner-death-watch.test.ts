import { describe, expect, it, vi } from 'vitest'
import { DisposableOwnerDeathWatch } from './disposable-owner-death-watch'

function esrch(): never {
  throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
}

describe('a disposable daemon retires with its owner', () => {
  it('NEGATIVE CONTROL: retires when the owner is gone, even with no graceful quit', () => {
    // The incident: candidate apps went away without running a quit path, and
    // their daemons — holding every supervised agent session — stayed up while
    // the state root was deleted out from under them.
    const onRetire = vi.fn()
    const watch = new DisposableOwnerDeathWatch({ ownerPid: 4242, onRetire, probe: esrch })
    watch.check()
    expect(onRetire).toHaveBeenCalledWith({ ownerPid: 4242, cause: 'owner-exited' })
  })

  it('retires exactly once', () => {
    const onRetire = vi.fn()
    const watch = new DisposableOwnerDeathWatch({ ownerPid: 4242, onRetire, probe: esrch })
    watch.check()
    watch.check()
    expect(onRetire).toHaveBeenCalledTimes(1)
  })

  it('does not retire while the owner is alive', () => {
    const onRetire = vi.fn()
    new DisposableOwnerDeathWatch({ ownerPid: process.pid, onRetire }).check()
    expect(onRetire).not.toHaveBeenCalled()
  })

  it('does not retire on EPERM or on an unknown probe failure', () => {
    for (const code of ['EPERM', undefined]) {
      const onRetire = vi.fn()
      new DisposableOwnerDeathWatch({
        ownerPid: 1,
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
})
