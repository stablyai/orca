import type { App } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  acquireSingleInstanceLock,
  logSingleInstanceLockBypass,
  logSingleInstanceLockFailure,
  shouldActivateDesktopForSecondInstance,
  shouldBypassSingleInstanceLock,
  shouldSkipSingleInstanceLock,
  SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE,
  SINGLE_INSTANCE_LOCK_BYPASS_MESSAGE,
  SINGLE_INSTANCE_LOCK_FAILURE_MESSAGE
} from './single-instance-lock'

type Listener = (...args: unknown[]) => void

function makeFakeApp(lockResult: boolean): {
  app: App
  requestSingleInstanceLock: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  listeners: Record<string, Listener[]>
} {
  const listeners: Record<string, Listener[]> = {}
  const requestSingleInstanceLock = vi.fn(() => lockResult)
  const on = vi.fn((event: string, cb: Listener) => {
    listeners[event] = listeners[event] ?? []
    listeners[event].push(cb)
  })
  const app = {
    requestSingleInstanceLock,
    on
  } as unknown as App
  return { app, requestSingleInstanceLock, on, listeners }
}

describe('acquireSingleInstanceLock', () => {
  it('returns false and does NOT register second-instance when the lock is held', () => {
    const onSecondInstance = vi.fn()
    const fake = makeFakeApp(false)

    const acquired = acquireSingleInstanceLock(fake.app, onSecondInstance)

    expect(acquired).toBe(false)
    expect(fake.requestSingleInstanceLock).toHaveBeenCalledTimes(1)
    // Why: if we registered the listener on a losing process, focusing the
    // existing window would become our job even though the primary owns
    // that UX surface. Verify no listener was added.
    expect(fake.on).not.toHaveBeenCalled()
    expect(fake.listeners['second-instance']).toBeUndefined()
  })

  it('returns true and registers exactly one second-instance listener when the lock is acquired', () => {
    const onSecondInstance = vi.fn()
    const fake = makeFakeApp(true)

    const acquired = acquireSingleInstanceLock(fake.app, onSecondInstance)

    expect(acquired).toBe(true)
    expect(fake.requestSingleInstanceLock).toHaveBeenCalledTimes(1)
    expect(fake.on).toHaveBeenCalledTimes(1)
    expect(fake.on).toHaveBeenCalledWith('second-instance', expect.any(Function))
    expect(fake.listeners['second-instance']).toHaveLength(1)
  })

  it('forwards the second launch argv so the owner can decide whether to activate', () => {
    const onSecondInstance = vi.fn()
    const fake = makeFakeApp(true)

    acquireSingleInstanceLock(fake.app, onSecondInstance)

    const [registered] = fake.listeners['second-instance'] ?? []
    expect(registered).toBeDefined()
    registered?.({}, ['/opt/orca/orca-linux.AppImage', '--serve'], '/home/orca')

    expect(onSecondInstance).toHaveBeenCalledTimes(1)
    expect(onSecondInstance).toHaveBeenCalledWith(['/opt/orca/orca-linux.AppImage', '--serve'])
  })
})

describe('shouldActivateDesktopForSecondInstance', () => {
  it('ignores a duplicate serve launch but still activates for a desktop launch', () => {
    // Why: a supervisor respawning `orca serve` must not open a window on a display-less host (#11935).
    const serveArgv = ['/opt/orca/orca-linux.AppImage', '--serve']
    expect(shouldActivateDesktopForSecondInstance(serveArgv)).toBe(false)
    expect(shouldActivateDesktopForSecondInstance(['/Applications/Orca.app/orca'])).toBe(true)
  })

  it('ignores a duplicate CLI-form serve launch the CLI redirect never rewrote', () => {
    // Why: the documented systemd unit is `<binary> serve --port 6768 …`; an extracted AppRun/binary
    // start reaches Electron in that shape, so a flag-only check would open a window on the live server.
    expect(
      shouldActivateDesktopForSecondInstance([
        '/opt/orca/squashfs-root/orca-ide',
        'serve',
        '--port',
        '6768',
        '--pairing-address',
        '100.64.1.20'
      ])
    ).toBe(false)
    // A path argument that merely contains `serve` is still a desktop launch.
    expect(
      shouldActivateDesktopForSecondInstance(['/opt/orca/orca-ide', '/home/u/serve-repo'])
    ).toBe(true)
  })

  it('fails open when no argv is available', () => {
    expect(shouldActivateDesktopForSecondInstance([])).toBe(true)
    expect(shouldActivateDesktopForSecondInstance()).toBe(true)
  })
})

describe('SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE', () => {
  it('stays 3 because the documented systemd unit keys RestartPreventExitStatus off it', () => {
    expect(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE).toBe(3)
  })
})

describe('shouldSkipSingleInstanceLock', () => {
  it('keeps ordinary dev multi-instance behavior but never skips for serve', () => {
    expect(shouldSkipSingleInstanceLock({ isDev: true, isServeMode: false, env: {} })).toBe(true)
    expect(shouldSkipSingleInstanceLock({ isDev: true, isServeMode: true, env: {} })).toBe(false)
    expect(shouldSkipSingleInstanceLock({ isDev: false, isServeMode: false, env: {} })).toBe(false)
  })

  it('lets isolated E2E exercise the production single-instance path', () => {
    expect(
      shouldSkipSingleInstanceLock({
        isDev: true,
        isServeMode: false,
        env: { ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK: '1' }
      })
    ).toBe(false)
  })
})

describe('logSingleInstanceLockFailure', () => {
  it('emits a production-visible synchronous diagnostic for the early quit path', () => {
    const write = vi.fn()

    logSingleInstanceLockFailure(write)

    expect(write).toHaveBeenCalledWith(2, `${SINGLE_INSTANCE_LOCK_FAILURE_MESSAGE}\n`)
    expect(write.mock.calls[0]?.[1]).toContain('Electron/macOS single-instance lock failure')
  })
})

describe('shouldBypassSingleInstanceLock', () => {
  it('allows the hidden diagnostic bypass only for packaged macOS app launches', () => {
    expect(
      shouldBypassSingleInstanceLock({
        env: { ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1' },
        isDev: false,
        isServeMode: false,
        platform: 'darwin'
      })
    ).toBe(true)
    expect(
      shouldBypassSingleInstanceLock({
        env: { ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1' },
        isDev: true,
        isServeMode: false,
        platform: 'darwin'
      })
    ).toBe(false)
    expect(
      shouldBypassSingleInstanceLock({
        env: { ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1' },
        isDev: false,
        isServeMode: false,
        platform: 'linux'
      })
    ).toBe(false)
  })
})

describe('logSingleInstanceLockBypass', () => {
  it('emits a warning when the diagnostic bypass is active', () => {
    const write = vi.fn()

    logSingleInstanceLockBypass(write)

    expect(write).toHaveBeenCalledWith(2, `${SINGLE_INSTANCE_LOCK_BYPASS_MESSAGE}\n`)
    expect(write.mock.calls[0]?.[1]).toContain('bypassing the packaged macOS single-instance lock')
  })
})
