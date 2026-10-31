import { describe, expect, it, vi } from 'vitest'
import { RuntimeSubscriptionRegistry } from './runtime-subscription-registry'

describe('subscription registration versions', () => {
  it.each(['conn-a', undefined])(
    'fences a delayed unsubscribe across replacement (%s)',
    async (connectionId) => {
      const registry = new RuntimeSubscriptionRegistry()
      const originalCleanup = vi.fn()
      const replacementCleanup = vi.fn()
      registry.register('terminal:generation', originalCleanup, 'conn-a')
      const admittedVersion = registry.getRegistrationVersion()
      registry.register('terminal:generation', replacementCleanup, 'conn-a')

      expect(
        registry.cleanupIfOwnedByConnection('terminal:generation', connectionId, admittedVersion)
      ).toBe(false)
      await Promise.resolve()
      expect(originalCleanup).toHaveBeenCalledTimes(1)
      expect(replacementCleanup).not.toHaveBeenCalled()

      expect(
        registry.cleanupIfOwnedByConnection(
          'terminal:generation',
          connectionId,
          registry.getRegistrationVersion()
        )
      ).toBe(true)
      await registry.cleanupAndWait('terminal:generation')
      expect(replacementCleanup).toHaveBeenCalledTimes(1)
    }
  )

  it('does not let a missing target at admission cancel a later registration', async () => {
    const registry = new RuntimeSubscriptionRegistry()
    const admittedVersion = registry.getRegistrationVersion()
    const cleanup = vi.fn()
    registry.register('terminal:later', cleanup, 'conn-a')
    expect(registry.cleanupIfOwnedByConnection('terminal:later', 'conn-a', admittedVersion)).toBe(
      false
    )
    expect(cleanup).not.toHaveBeenCalled()
    await registry.cleanupAndWait('terminal:later')
  })

  it('allows admitted cleanup after unrelated subscriptions register', async () => {
    const registry = new RuntimeSubscriptionRegistry()
    const cleanup = vi.fn()
    registry.register('terminal:first', cleanup, 'conn-a')
    const admittedVersion = registry.getRegistrationVersion()
    registry.register('terminal:other', vi.fn(), 'conn-a')
    expect(registry.cleanupIfOwnedByConnection('terminal:first', 'conn-a', admittedVersion)).toBe(
      true
    )
    await registry.cleanupAndWait('terminal:first')
    expect(cleanup).toHaveBeenCalledTimes(1)
    await registry.cleanupAndWait('terminal:other')
  })

  it('still refuses a different connection with a current registration version', async () => {
    const registry = new RuntimeSubscriptionRegistry()
    const cleanup = vi.fn()
    registry.register('terminal:owned', cleanup, 'conn-a')
    expect(
      registry.cleanupIfOwnedByConnection(
        'terminal:owned',
        'conn-b',
        registry.getRegistrationVersion()
      )
    ).toBe(false)
    expect(cleanup).not.toHaveBeenCalled()
    await registry.cleanupAndWait('terminal:owned')
  })

  it('reports an already-retired subscription as gone', async () => {
    const registry = new RuntimeSubscriptionRegistry()
    registry.register('terminal:retired', vi.fn(), 'conn-a')
    const admittedVersion = registry.getRegistrationVersion()
    await registry.cleanupAndWait('terminal:retired')
    expect(registry.cleanupIfOwnedByConnection('terminal:retired', 'conn-a', admittedVersion)).toBe(
      true
    )
  })

  it('keeps registration ownership even when a cleanup callback is reused', async () => {
    const registry = new RuntimeSubscriptionRegistry()
    const cleanup = vi.fn()
    const original = registry.registerOwned('terminal:reused', cleanup, 'conn')
    const replacement = registry.registerOwned('terminal:reused', cleanup, 'conn')
    original.releaseIfCurrent()
    await Promise.resolve()
    expect(cleanup).toHaveBeenCalledTimes(1)
    replacement.releaseIfCurrent()
    await registry.cleanupAndWait('terminal:reused')
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('does not merge different registrations of the same async cleanup callback', async () => {
    const registry = new RuntimeSubscriptionRegistry()
    const gate = Promise.withResolvers<void>()
    const cleanup = vi.fn(() => gate.promise)
    registry.register('terminal:async', cleanup, 'conn')
    const originalCleanup = registry.cleanupAndWait('terminal:async')
    registry.register('terminal:async', cleanup, 'conn')
    const replacementCleanup = registry.cleanupAndWait('terminal:async')
    expect(cleanup).toHaveBeenCalledTimes(2)
    gate.resolve()
    await Promise.all([originalCleanup, replacementCleanup])
  })

  it('does not retry a replaced registration that reused the cleanup callback', async () => {
    const registry = new RuntimeSubscriptionRegistry()
    const gate = Promise.withResolvers<void>()
    const cleanup = vi.fn()
    registry.register('terminal:retry', cleanup, 'conn')
    registry.retryAfter('terminal:retry', cleanup, gate.promise)
    registry.register('terminal:retry', cleanup, 'conn')
    gate.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(cleanup).toHaveBeenCalledTimes(1)
    await registry.cleanupAndWait('terminal:retry')
    expect(cleanup).toHaveBeenCalledTimes(2)
  })
})

describe('request-addressed release', () => {
  const requestAddresses = (registry: RuntimeSubscriptionRegistry): number =>
    registry['subscriptionsByRequest'].size
  // Never `cleanupAndWait` here: it would run the cleanup itself and hide a missed release.
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('releases the registration a request created, and forgets the address', async () => {
    const registry = new RuntimeSubscriptionRegistry()
    const cleanup = vi.fn()
    registry.registerOwned('terminal:slot', cleanup, 'conn-a', 'req-1')
    expect(requestAddresses(registry)).toBe(1)

    registry.releaseByRequest('conn-a', 'req-1')
    await settle()

    expect(cleanup).toHaveBeenCalledOnce()
    expect(requestAddresses(registry)).toBe(0)
  })

  it('ignores the request a same-slot replacement superseded', async () => {
    const registry = new RuntimeSubscriptionRegistry()
    const replacement = vi.fn()
    registry.registerOwned('terminal:slot', vi.fn(), 'conn-a', 'req-old')
    registry.registerOwned('terminal:slot', replacement, 'conn-a', 'req-new')
    expect(requestAddresses(registry)).toBe(1)

    registry.releaseByRequest('conn-a', 'req-old')
    await settle()
    expect(replacement).not.toHaveBeenCalled()

    registry.releaseByRequest('conn-a', 'req-new')
    await settle()
    expect(replacement).toHaveBeenCalledOnce()
  })

  it('does not grow across replace and release cycles', async () => {
    const registry = new RuntimeSubscriptionRegistry()
    const cleanup = vi.fn()
    for (let i = 0; i < 50; i++) {
      registry.registerOwned('terminal:slot', cleanup, 'conn-a', `req-${2 * i}`)
      registry.registerOwned('terminal:slot', cleanup, 'conn-a', `req-${2 * i + 1}`)
      expect(requestAddresses(registry)).toBe(1)
      registry.releaseByRequest('conn-a', `req-${2 * i + 1}`)
      await settle()
    }
    expect(cleanup).toHaveBeenCalledTimes(100)
    expect(requestAddresses(registry)).toBe(0)
  })

  it('keeps the newer owner when a reused request id outlives the old release', async () => {
    const registry = new RuntimeSubscriptionRegistry()
    const gate = Promise.withResolvers<void>()
    const newer = vi.fn()
    // IPC aborts a subscription and reuses its id before the old teardown settles.
    const old = registry.registerOwned('terminal:old', () => gate.promise, 'ipc', 'sub-1')
    old.releaseIfCurrent()
    registry.registerOwned('terminal:new', newer, 'ipc', 'sub-1')
    gate.resolve()
    await settle()

    registry.releaseByRequest('ipc', 'sub-1')
    await settle()
    expect(newer).toHaveBeenCalledOnce()
    expect(requestAddresses(registry)).toBe(0)
  })

  it('keeps the address of a registration whose cleanup failed, so a retry still reaches it', async () => {
    const registry = new RuntimeSubscriptionRegistry()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cleanup = vi.fn().mockRejectedValueOnce(new Error('teardown failed'))
    registry.registerOwned('terminal:slot', cleanup, 'conn-a', 'req-1')

    registry.releaseByRequest('conn-a', 'req-1')
    await settle()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(requestAddresses(registry)).toBe(1)

    registry.releaseByRequest('conn-a', 'req-1')
    await settle()
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(requestAddresses(registry)).toBe(0)
    consoleError.mockRestore()
  })

  it('addresses nothing without both a connection and a request id', async () => {
    const registry = new RuntimeSubscriptionRegistry()
    const unaddressed = vi.fn()
    const addressed = vi.fn()
    registry.registerOwned('terminal:no-conn', unaddressed, undefined, 'req-1')
    registry.registerOwned('terminal:no-req', vi.fn(), 'conn-a')
    registry.registerOwned('terminal:addressed', addressed, 'conn-a', 'req-1')
    expect(requestAddresses(registry)).toBe(1)

    registry.releaseByRequest(undefined, 'req-1')
    registry.releaseByRequest('conn-b', 'req-1')
    await settle()

    expect(unaddressed).not.toHaveBeenCalled()
    expect(addressed).not.toHaveBeenCalled()
    await registry.cleanupAndWait('terminal:addressed')
  })
})
