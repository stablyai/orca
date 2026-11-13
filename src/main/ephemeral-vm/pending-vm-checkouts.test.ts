import '../../shared/remote-runtime/host-store/environment-store-worker.test-support'
import { describe, expect, it } from 'vitest'
import {
  PendingVmCheckoutRegistry,
  publishPendingVmCheckoutRepoChanges
} from './pending-vm-checkouts'

describe('PendingVmCheckoutRegistry', () => {
  it('tells phones to re-read each repo whose pending checkout appeared or went away', () => {
    const registry = new PendingVmCheckoutRegistry()
    registry.publish(1, [{ repoId: 'already', path: '/x' }])
    const notified: string[] = []
    const stop = publishPendingVmCheckoutRepoChanges(registry, (repoId) => notified.push(repoId))

    registry.publish(2, [{ repoId: 'vm', path: '/srv/repo' }])
    expect(notified).toEqual(['vm'])

    // Another window's unrelated change does not re-announce this repo.
    registry.publish(1, [])
    expect(notified).toEqual(['vm', 'already'])

    registry.publish(2, [])
    expect(notified).toEqual(['vm', 'already', 'vm'])

    stop()
    registry.publish(2, [{ repoId: 'later', path: '/l' }])
    expect(notified).toEqual(['vm', 'already', 'vm'])
  })
})
