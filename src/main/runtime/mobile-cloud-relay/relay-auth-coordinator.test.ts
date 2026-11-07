import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAuthCoordinator } from './relay-auth-coordinator'
import type { RelayAuthContext } from './relay-auth-identity'
import type { RelayAccessTokenRefresh } from './relay-session-broker-contract'

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
  afterEach(() => vi.useRealTimers())

  it('rejects a token refresh whose session read crosses an auth mutation', async () => {
    const refreshRead = deferred<RelayAuthContext | null>()
    let readCount = 0
    let current = context
    let refreshAccessToken: (() => Promise<RelayAccessTokenRefresh>) | null = null
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

    await expect(refreshing).resolves.toEqual({ accessToken: null })
    await vi.waitFor(() => expect(readCount).toBeGreaterThanOrEqual(3))
  })
})
