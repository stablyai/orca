import { describe, expect, it, vi } from 'vitest'

import type { BrowserClientHostLeaseAuthority } from '../../shared/browser-client-host-protocol'
import { retireBrowserRoutePartitionStorageForEnvironment } from './browser-route-partition-storage-retirement'
import { PairedRuntimeBrowserClientHostComposition } from './paired-runtime-browser-client-host-composition'
import { PairedRuntimeBrowserClientHostRegistry } from './paired-runtime-browser-client-host-registry'

const partition = `persist:orca-browser-v1-${'a'.repeat(64)}`

const leaseAuthority: BrowserClientHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'client-a',
  browserHostGeneration: 1,
  pageCommandProtocolVersion: 1
}

async function drainTasks(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function stubRoutes() {
  return {
    retain: vi.fn(),
    suspend: vi.fn(),
    reconnect: vi.fn(async () => {}),
    retire: vi.fn(async () => {}),
    close: vi.fn(async () => {})
  }
}

function stubExecutor(onClose: () => void) {
  return {
    handle: vi.fn(async () => ({ status: 'completed' as const })),
    retirePage: vi.fn(async () => true),
    hasUnresolvedPage: vi.fn(() => false),
    beginAuthorityTransition: vi.fn(),
    completeAuthorityTransition: vi.fn(),
    fenceNavigation: vi.fn(),
    snapshotPageInventory: vi.fn(() => []),
    close: vi.fn(async () => {
      onClose()
    })
  }
}

function stubHost(
  callbacks: { onAuthority(authority: BrowserClientHostLeaseAuthority): void },
  handlersSettled: Promise<void>
) {
  return {
    start: vi.fn(async () => {
      callbacks.onAuthority(leaseAuthority)
      return leaseAuthority
    }),
    retirePage: vi.fn(async () => true),
    forgetPage: vi.fn(() => true),
    whenHandlersSettled: vi.fn(() => handlersSettled),
    refreshPageInventory: vi.fn(async () => {}),
    // Why: an automation handler that outlives the join makes the composition defer executor close.
    close: vi.fn(async () => false)
  }
}

describe('browser route partition storage retirement', () => {
  it('clears a removed environment only after its client host finishes tearing down', async () => {
    const order: string[] = []
    let finishTeardown = (): void => {}
    const whenClientHostClosed = new Promise<void>((resolve) => {
      finishTeardown = () => {
        order.push('teardown')
        resolve()
      }
    })
    const clearStorage = vi.fn(async () => {
      order.push('clear')
      return { clearedPartitions: [partition], livePartitions: [] }
    })

    const retiring = retireBrowserRoutePartitionStorageForEnvironment({
      environmentId: 'environment-a',
      whenClientHostClosed,
      clearStorage,
      retryDelayMs: 0
    })
    await Promise.resolve()
    expect(clearStorage).not.toHaveBeenCalled()

    finishTeardown()

    expect(await retiring).toEqual([partition])
    expect(order).toEqual(['teardown', 'clear'])
    expect(clearStorage).toHaveBeenCalledOnce()
  })

  it('waits for the executor close a busy host deferred before clearing', async () => {
    const order: string[] = []
    let settleHandlers = (): void => {}
    const handlersSettled = new Promise<void>((resolve) => {
      settleHandlers = resolve
    })
    let partitionRetained = true
    const registry = new PairedRuntimeBrowserClientHostRegistry<{
      environmentId: string
      pairingRevision: number
      authorityRuntimeId: string
      authorityConnectionIdentity: string
      legacyAuthorityConnectionIdentity: string
    }>({
      createComposition: () =>
        new PairedRuntimeBrowserClientHostComposition({
          initialInput: {
            environmentId: 'environment-a',
            pairingRevision: 1,
            authorityRuntimeId: 'runtime-a',
            authorityConnectionIdentity: 'authority-a',
            legacyAuthorityConnectionIdentity: 'legacy-authority-a'
          },
          createRoutes: () => stubRoutes(),
          // Why: releasing the page's partition is what the executor close does in production.
          createExecutor: () =>
            stubExecutor(() => {
              order.push('close-executor')
              partitionRetained = false
            }),
          createHost: (_input, callbacks) => stubHost(callbacks, handlersSettled)
        })
    })
    await registry.start({
      environmentId: 'environment-a',
      pairingRevision: 1,
      authorityRuntimeId: 'runtime-a',
      authorityConnectionIdentity: 'authority-a',
      legacyAuthorityConnectionIdentity: 'legacy-authority-a'
    })

    const retiring = retireBrowserRoutePartitionStorageForEnvironment({
      environmentId: 'environment-a',
      whenClientHostClosed: registry.retireEnvironment('environment-a'),
      clearStorage: async () => {
        order.push('clear')
        return partitionRetained
          ? { clearedPartitions: [], livePartitions: [partition] }
          : { clearedPartitions: [partition], livePartitions: [] }
      },
      retryDelayMs: 0
    })
    // Why: the clear must still be waiting after the host close itself resolved, not merely be
    // ordered behind it by microtask luck.
    await drainTasks()
    expect(order).toEqual([])

    settleHandlers()

    expect(await retiring).toEqual([partition])
    expect(order).toEqual(['close-executor', 'clear'])
  })

  it('retries a partition that was still live during the first pass', async () => {
    const clearStorage = vi
      .fn()
      .mockResolvedValueOnce({ clearedPartitions: [], livePartitions: [partition] })
      .mockResolvedValueOnce({ clearedPartitions: [partition], livePartitions: [] })
    const onError = vi.fn()

    const cleared = await retireBrowserRoutePartitionStorageForEnvironment({
      environmentId: 'environment-a',
      whenClientHostClosed: Promise.resolve(),
      clearStorage,
      retryDelayMs: 0,
      onError
    })

    expect(cleared).toEqual([partition])
    expect(clearStorage).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a partition that stays live and never retries a third time', async () => {
    const clearStorage = vi
      .fn()
      .mockResolvedValue({ clearedPartitions: [], livePartitions: [partition] })
    const onError = vi.fn()

    const cleared = await retireBrowserRoutePartitionStorageForEnvironment({
      environmentId: 'environment-a',
      whenClientHostClosed: Promise.resolve(),
      clearStorage,
      retryDelayMs: 0,
      onError
    })

    expect(cleared).toEqual([])
    expect(clearStorage).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining(partition) })
    )
  })

  it('still clears storage when the client host teardown fails', async () => {
    const clearStorage = vi
      .fn()
      .mockResolvedValue({ clearedPartitions: [partition], livePartitions: [] })
    const onError = vi.fn()

    const cleared = await retireBrowserRoutePartitionStorageForEnvironment({
      environmentId: 'environment-a',
      whenClientHostClosed: Promise.reject(new Error('teardown failed')),
      clearStorage,
      retryDelayMs: 0,
      onError
    })

    expect(cleared).toEqual([partition])
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'teardown failed' }))
  })
})
