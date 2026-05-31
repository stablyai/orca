import type { App } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  acquireSingleInstanceLock,
  logSingleInstanceLockBypass,
  logSingleInstanceLockFailure,
  shouldBypassSingleInstanceLock,
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
    expect(fake.on).toHaveBeenCalledWith('second-instance', onSecondInstance)
    expect(fake.listeners['second-instance']).toHaveLength(1)
  })

  it('fires the registered callback when second-instance dispatches', () => {
    const onSecondInstance = vi.fn()
    const fake = makeFakeApp(true)

    acquireSingleInstanceLock(fake.app, onSecondInstance)

    const [registered] = fake.listeners['second-instance'] ?? []
    expect(registered).toBeDefined()
    registered?.()

    expect(onSecondInstance).toHaveBeenCalledTimes(1)
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
