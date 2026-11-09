import { describe, expect, it, vi } from 'vitest'
import { isPendingVmCheckout } from '../../shared/pending-vm-checkouts'
import { PendingVmCheckoutRegistry } from './pending-vm-checkouts'

describe('PendingVmCheckoutRegistry', () => {
  it("serves every window's pending checkouts and drops a window that publishes none", () => {
    const registry = new PendingVmCheckoutRegistry()
    const changed = vi.fn()
    registry.onChanged(changed)

    registry.publish(1, [{ repoId: 'vm-a', path: '/a' }])
    registry.publish(2, [{ repoId: 'vm-b', path: '/b' }])
    expect(isPendingVmCheckout(registry.current(), { repoId: 'vm-a', path: '/a' })).toBe(true)
    expect(isPendingVmCheckout(registry.current(), { repoId: 'vm-b', path: '/b' })).toBe(true)

    registry.publish(1, [])
    expect(registry.list()).toEqual([{ repoId: 'vm-b', path: '/b' }])
    expect(isPendingVmCheckout(registry.current(), { repoId: 'vm-a', path: '/a' })).toBe(false)

    // A window with nothing published stays quiet.
    registry.publish(3, [])
    expect(changed).toHaveBeenCalledTimes(3)
  })
})
