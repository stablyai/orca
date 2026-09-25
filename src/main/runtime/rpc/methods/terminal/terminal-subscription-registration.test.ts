import { describe, expect, it, vi } from 'vitest'
import { RuntimeSubscriptionRegistry } from '../../../runtime-subscription-registry'
import { registerTerminalSubscription } from './terminal-subscription-registration'

const SUBSCRIPTION_ID = 'terminal-1:phone-1'

function createRegistration(
  requestSignal?: AbortSignal,
  registry = new RuntimeSubscriptionRegistry()
) {
  const runtime = {
    registerOwnedSubscriptionCleanup: registry.registerOwned.bind(registry),
    subscribeToPtyExit: vi.fn((_ptyId: string, _listener: () => void) => vi.fn()),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn()
  }
  const emit = vi.fn()
  const registration = registerTerminalSubscription({
    runtime,
    subscriptionId: SUBSCRIPTION_ID,
    connectionId: 'conn-a',
    requestSignal,
    emit
  })
  return { registry, runtime, emit, registration }
}

describe('terminal subscription registration', () => {
  it('runs its teardown once when the teardown re-enters release', () => {
    const { registry, emit, registration } = createRegistration()
    const teardown = vi.fn(() => {
      registration.release()
      registry.cleanup(SUBSCRIPTION_ID)
    })
    registration.setTeardown(teardown)

    registration.release()

    expect(teardown).toHaveBeenCalledOnce()
    expect(emit.mock.calls).toEqual([[{ type: 'end' }]])
    expect(registration.signal.aborted).toBe(true)
  })

  it('runs a teardown set after release immediately', () => {
    const { registration } = createRegistration()
    registration.release()
    const teardown = vi.fn()

    registration.setTeardown(teardown)

    expect(teardown).toHaveBeenCalledOnce()
  })

  it('is released on arrival, without taking the slot, when the request signal is already aborted', () => {
    const registry = new RuntimeSubscriptionRegistry()
    const liveCleanup = vi.fn()
    registry.registerOwned(SUBSCRIPTION_ID, liveCleanup, 'conn-a')
    const request = new AbortController()
    request.abort()
    const { emit, registration } = createRegistration(request.signal, registry)

    expect(registration.released).toBe(true)
    expect(registration.signal.aborted).toBe(true)
    expect(emit).not.toHaveBeenCalled()
    expect(liveCleanup).not.toHaveBeenCalled()
    expect(registry.cleanupIfOwnedByConnection(SUBSCRIPTION_ID, 'conn-a')).toBe(true)
    expect(liveCleanup).toHaveBeenCalledOnce()
  })

  it('removes phone presence and aborts even when the teardown throws', async () => {
    const { runtime, registration } = createRegistration()
    void registration.addMobilePresence('pty-1', 'phone-1', undefined)
    registration.setTeardown(() => {
      throw new Error('flush_failed')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    registration.release()

    expect(runtime.handleMobileUnsubscribe).toHaveBeenCalledWith('pty-1', 'phone-1')
    expect(registration.signal.aborted).toBe(true)
    await vi.waitFor(() => expect(error).toHaveBeenCalled())
    error.mockRestore()
  })

  it('adds no presence after release', async () => {
    const { runtime, registration } = createRegistration()
    registration.release()

    await registration.addMobilePresence('pty-1', 'phone-1', undefined)

    expect(runtime.handleMobileSubscribe).not.toHaveBeenCalled()
    expect(runtime.handleMobileUnsubscribe).not.toHaveBeenCalled()
  })

  it('releases silently without end', () => {
    const { emit, registration } = createRegistration()

    registration.releaseSilently()
    registration.release()

    expect(registration.released).toBe(true)
    expect(emit).not.toHaveBeenCalled()
  })

  it('stops watching for pty exit when released, and releases on exit', () => {
    const { runtime, emit, registration } = createRegistration()
    let onExit = (): void => {}
    const stopWatching = vi.fn()
    runtime.subscribeToPtyExit.mockImplementation((_ptyId: string, listener: () => void) => {
      onExit = listener
      return stopWatching
    })
    registration.releaseOnPtyExit('pty-1')

    onExit()

    expect(registration.released).toBe(true)
    expect(stopWatching).toHaveBeenCalledOnce()
    expect(emit.mock.calls).toEqual([[{ type: 'end' }]])
  })
})
