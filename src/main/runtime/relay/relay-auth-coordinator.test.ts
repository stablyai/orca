import { describe, expect, it, vi } from 'vitest'
import { RelayAuthCoordinator, type RelayAuthContext } from './relay-auth-coordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const context: RelayAuthContext = {
  identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
  accessToken: 'access-1',
  relayEntitled: true
}

describe('RelayAuthCoordinator', () => {
  it('stays signed-in but does not open a broker without relay demand', async () => {
    const openBroker = vi.fn()
    const statuses: string[] = []
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      hasDemand: () => false,
      openBroker,
      onStatus: (status) => statuses.push(status)
    })
    coordinator.reconcile()
    await coordinator.waitForActiveBroker()
    expect(openBroker).not.toHaveBeenCalled()
    expect(statuses.at(-1)).toBe('standby')
  })

  it('opens on demand and lingers before closing the last control', async () => {
    let demanded = false
    const broker = { closeNow: vi.fn() }
    const statuses: string[] = []
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      hasDemand: () => demanded,
      openBroker: async () => broker,
      onStatus: (status) => statuses.push(status),
      lingerMs: 250
    })
    coordinator.reconcile()
    await coordinator.waitForActiveBroker()
    demanded = true
    coordinator.reconcile()
    await expect(coordinator.waitForActiveBroker()).resolves.toBe(broker)
    demanded = false
    coordinator.reconcile()
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('standby'))
    expect(broker.closeNow).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(broker.closeNow).toHaveBeenCalledOnce())
  })

  it('cancels linger when demand returns', async () => {
    let demanded = true
    const broker = { closeNow: vi.fn() }
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      hasDemand: () => demanded,
      openBroker: async () => broker,
      onStatus: vi.fn(),
      lingerMs: 20
    })
    coordinator.reconcile()
    await expect(coordinator.waitForActiveBroker()).resolves.toBe(broker)
    demanded = false
    coordinator.reconcile()
    demanded = true
    coordinator.reconcile()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(broker.closeNow).not.toHaveBeenCalled()
  })

  it('does not carry old-profile demand through an identity switch', async () => {
    let current = context
    const broker = { closeNow: vi.fn() }
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => current,
      hasDemand: ({ identity }) => identity.profileId === 'profile-1',
      openBroker: async () => broker,
      onStatus: vi.fn(),
      lingerMs: 10_000
    })
    coordinator.reconcile()
    await expect(coordinator.waitForActiveBroker()).resolves.toBe(broker)
    current = { ...context, identity: { ...context.identity, profileId: 'profile-2' } }
    coordinator.reconcile()
    await coordinator.waitForActiveBroker()
    expect(broker.closeNow).toHaveBeenCalledOnce()
  })

  it('fences a session read that finishes after sign-out', async () => {
    const read = deferred<RelayAuthContext | null>()
    const openBroker = vi.fn()
    const statuses: string[] = []
    const coordinator = new RelayAuthCoordinator({
      readContext: () => read.promise,
      openBroker,
      onStatus: (status) => statuses.push(status)
    })
    coordinator.reconcile()
    coordinator.fenceAndCloseNow()
    read.resolve(context)
    await vi.waitFor(() => expect(openBroker).not.toHaveBeenCalled())
    expect(statuses.at(-1)).toBe('offline')
  })

  it('closes a broker whose open finishes after an identity mutation', async () => {
    const opened = deferred<{ closeNow(): void }>()
    const staleClose = vi.fn()
    const readContext = vi
      .fn<() => Promise<RelayAuthContext | null>>()
      .mockResolvedValueOnce(context)
      .mockResolvedValueOnce({
        ...context,
        identity: { ...context.identity, organizationId: 'org-2' }
      })
    const openBroker = vi
      .fn()
      .mockImplementationOnce(() => opened.promise)
      .mockResolvedValueOnce({ closeNow: vi.fn() })
    const coordinator = new RelayAuthCoordinator({
      readContext,
      openBroker,
      onStatus: vi.fn()
    })
    coordinator.reconcile()
    await vi.waitFor(() => expect(openBroker).toHaveBeenCalledOnce())
    coordinator.reconcile()
    await vi.waitFor(() => expect(openBroker).toHaveBeenCalledTimes(2))
    opened.resolve({ closeNow: staleClose })
    await vi.waitFor(() => expect(staleClose).toHaveBeenCalledOnce())
  })

  it('keeps one broker for duplicate events with unchanged identity', async () => {
    const broker = { closeNow: vi.fn() }
    const openBroker = vi.fn(async () => broker)
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn()
    })
    coordinator.reconcile()
    await vi.waitFor(() => expect(openBroker).toHaveBeenCalledOnce())
    coordinator.reconcile()
    await vi.waitFor(() => expect(openBroker).toHaveBeenCalledOnce())
    expect(broker.closeNow).not.toHaveBeenCalled()
  })

  it('rejects a refresh result after capability removal', async () => {
    let current: RelayAuthContext | null = context
    let refreshAccessToken: (() => Promise<string | null>) | null = null
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => current,
      openBroker: async (input) => {
        refreshAccessToken = input.refreshAccessToken
        return { closeNow: vi.fn() }
      },
      onStatus: vi.fn()
    })
    coordinator.reconcile()
    await vi.waitFor(() => expect(refreshAccessToken).not.toBeNull())
    current = { ...context, relayEntitled: false }
    coordinator.reconcile()
    await expect(refreshAccessToken!()).resolves.toBeNull()
  })

  it('invalidates pending ownership immediately while broker opening is paused', async () => {
    const firstOpen = deferred<{ closeNow(): void }>()
    const firstClose = vi.fn()
    let firstIsCurrent: (() => boolean) | null = null
    const openBroker = vi
      .fn()
      .mockImplementationOnce((input) => {
        firstIsCurrent = input.isCurrent
        return firstOpen.promise
      })
      .mockResolvedValueOnce({ closeNow: vi.fn() })
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker,
      onStatus: vi.fn()
    })

    coordinator.reconcile()
    await vi.waitFor(() => expect(firstIsCurrent).not.toBeNull())
    coordinator.reconcile()
    expect(firstIsCurrent!()).toBe(false)
    await vi.waitFor(() => expect(openBroker).toHaveBeenCalledTimes(2))
    firstOpen.resolve({ closeNow: firstClose })
    await vi.waitFor(() => expect(firstClose).toHaveBeenCalledOnce())
  })

  it('rejects a token refresh whose session read crosses an auth mutation', async () => {
    const refreshRead = deferred<RelayAuthContext | null>()
    let readCount = 0
    let current = context
    let refreshAccessToken: (() => Promise<string | null>) | null = null
    const coordinator = new RelayAuthCoordinator({
      readContext: () => {
        readCount += 1
        return readCount === 2 ? refreshRead.promise : Promise.resolve(current)
      },
      openBroker: async (input) => {
        refreshAccessToken = input.refreshAccessToken
        return { closeNow: vi.fn() }
      },
      onStatus: vi.fn()
    })
    coordinator.reconcile()
    await vi.waitFor(() => expect(refreshAccessToken).not.toBeNull())
    const refreshing = refreshAccessToken!()
    current = { ...context, identity: { ...context.identity, organizationId: 'org-2' } }
    coordinator.reconcile()
    refreshRead.resolve(context)

    await expect(refreshing).resolves.toBeNull()
    await vi.waitFor(() => expect(readCount).toBeGreaterThanOrEqual(3))
  })

  it('reconnects automatically after a signed-in process restart or relaunch fence', async () => {
    const firstBroker = { closeNow: vi.fn() }
    const firstCoordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      openBroker: async () => firstBroker,
      onStatus: vi.fn()
    })
    firstCoordinator.reconcile()
    await vi.waitFor(() => expect(firstCoordinator.getActiveBroker()).toBe(firstBroker))
    firstCoordinator.fenceAndCloseNow()
    expect(firstBroker.closeNow).toHaveBeenCalledOnce()

    const reopenedBroker = { closeNow: vi.fn() }
    const reopenedCoordinator = new RelayAuthCoordinator({
      // Why: normal quit/relaunch preserves the session store, so a fresh
      // process reads the same entitled identity and opens without new login.
      readContext: async () => context,
      openBroker: async () => reopenedBroker,
      onStatus: vi.fn()
    })
    reopenedCoordinator.reconcile()
    await vi.waitFor(() => expect(reopenedCoordinator.getActiveBroker()).toBe(reopenedBroker))
  })

  it('closes and reopens for valid profile and organization identity switches', async () => {
    let current = context
    const brokers = Array.from({ length: 3 }, () => ({ closeNow: vi.fn() }))
    const openBroker = vi
      .fn()
      .mockResolvedValueOnce(brokers[0])
      .mockResolvedValueOnce(brokers[1])
      .mockResolvedValueOnce(brokers[2])
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => current,
      openBroker,
      onStatus: vi.fn()
    })
    coordinator.reconcile()
    await vi.waitFor(() => expect(coordinator.getActiveBroker()).toBe(brokers[0]))

    current = { ...context, identity: { ...context.identity, profileId: 'profile-2' } }
    coordinator.reconcile()
    await vi.waitFor(() => expect(coordinator.getActiveBroker()).toBe(brokers[1]))
    expect(brokers[0]!.closeNow).toHaveBeenCalledOnce()

    current = {
      ...context,
      identity: { ...context.identity, profileId: 'profile-2', organizationId: 'org-2' }
    }
    coordinator.reconcile()
    await vi.waitFor(() => expect(coordinator.getActiveBroker()).toBe(brokers[2]))
    expect(brokers[1]!.closeNow).toHaveBeenCalledOnce()
  })
})
