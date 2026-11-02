import { describe, expect, it } from 'vitest'
import type { RuntimeGraphStatus } from '../../../shared/runtime-session-contracts'
import { OrcaRuntimeService } from '../orca-runtime'

class InventoryPublicationRuntime extends OrcaRuntimeService {
  setGraph(status: RuntimeGraphStatus, epoch: number): void {
    this.graphStatus = status
    this.rendererGraphEpoch = epoch
  }

  get epoch(): number | null {
    return this.sessionTabsInventoryPublicationEpoch
  }

  get pendingWaiterCount(): number {
    return this.sessionTabsInventoryWaiters.size
  }

  reset(): void {
    this.sessionTabsInventoryPublicationEpoch = null
  }

  addPublicationListener(listener: () => void): void {
    this.sessionTabsInventoryWaiters.add(listener)
  }

  removePublicationListener(listener: () => void): void {
    this.sessionTabsInventoryWaiters.delete(listener)
  }

  override waitForSessionTabsInventoryPublication(signal?: AbortSignal): Promise<void> {
    return super.waitForSessionTabsInventoryPublication(signal)
  }

  override getAuthoritativeSessionTabsInventoryEpoch(): number | null {
    return super.getAuthoritativeSessionTabsInventoryEpoch()
  }

  override markSessionTabsInventoryPublished(): void {
    super.markSessionTabsInventoryPublished()
  }
}

function inventoryPublication() {
  const publication = new InventoryPublicationRuntime(null)
  publication.setGraph('ready', 1)
  return { publication }
}

describe('session tab inventory publication ownership', () => {
  it('keeps publication and waiters isolated between runtime owners', async () => {
    const first = inventoryPublication()
    const second = inventoryPublication()
    const firstWait = first.publication.waitForSessionTabsInventoryPublication()
    const secondWait = second.publication.waitForSessionTabsInventoryPublication()

    first.publication.markSessionTabsInventoryPublished()
    await firstWait
    expect(first.publication.pendingWaiterCount).toBe(0)
    expect(second.publication.pendingWaiterCount).toBe(1)
    expect(second.publication.epoch).toBeNull()

    second.publication.markSessionTabsInventoryPublished()
    await secondWait
  })

  it('uses the live graph status and epoch after the owner was constructed', async () => {
    const { publication } = inventoryPublication()
    publication.markSessionTabsInventoryPublished()
    publication.setGraph('reloading', 2)
    expect(publication.getAuthoritativeSessionTabsInventoryEpoch()).toBeNull()
    const pending = publication.waitForSessionTabsInventoryPublication()
    expect(publication.pendingWaiterCount).toBe(1)

    publication.setGraph('ready', 2)
    publication.markSessionTabsInventoryPublished()
    await pending
    expect(publication.getAuthoritativeSessionTabsInventoryEpoch()).toBe(2)
  })

  it('keeps an unpublished waiter until the reset graph publishes', async () => {
    const { publication } = inventoryPublication()
    const pending = publication.waitForSessionTabsInventoryPublication()
    publication.reset()
    expect(publication.pendingWaiterCount).toBe(1)

    publication.markSessionTabsInventoryPublished()
    await pending
  })

  it('removes an already-aborted waiter before a later publication', async () => {
    const { publication } = inventoryPublication()
    const controller = new AbortController()
    controller.abort()

    await expect(
      publication.waitForSessionTabsInventoryPublication(controller.signal)
    ).rejects.toThrow('client_disconnected')
    expect(publication.pendingWaiterCount).toBe(0)
    publication.markSessionTabsInventoryPublished()
  })

  it('removes a newly-aborted waiter without cancelling another caller', async () => {
    const { publication } = inventoryPublication()
    const controller = new AbortController()
    const cancelled = publication.waitForSessionTabsInventoryPublication(controller.signal)
    const surviving = publication.waitForSessionTabsInventoryPublication()
    controller.abort()

    await expect(cancelled).rejects.toThrow('client_disconnected')
    expect(publication.pendingWaiterCount).toBe(1)
    publication.markSessionTabsInventoryPublished()
    await surviving
  })

  it('notifies a captured listener set once per epoch', () => {
    const { publication } = inventoryPublication()
    const calls: string[] = []
    const addedDuringPublication = (): void => {
      calls.push('added')
      publication.removePublicationListener(addedDuringPublication)
    }
    const first = (): void => {
      calls.push('first')
      publication.removePublicationListener(first)
      publication.addPublicationListener(addedDuringPublication)
    }
    publication.addPublicationListener(first)

    publication.markSessionTabsInventoryPublished()
    publication.markSessionTabsInventoryPublished()
    expect(calls).toEqual(['first'])
    expect(publication.pendingWaiterCount).toBe(1)

    publication.setGraph('ready', 2)
    publication.markSessionTabsInventoryPublished()
    expect(calls).toEqual(['first', 'added'])
    expect(publication.pendingWaiterCount).toBe(0)
  })
})
