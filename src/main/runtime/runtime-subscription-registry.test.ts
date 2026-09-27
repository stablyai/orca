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
