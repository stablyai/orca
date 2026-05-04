import type { App } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { acquireSingleInstanceLock } from './single-instance-lock'

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
