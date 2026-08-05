import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { HostProfile } from './types'

const forceReconnect = vi.fn(async () => {})
const recoverMobileRelayPairing = vi.fn()

vi.mock('./client-context', () => ({ useForceReconnect: () => forceReconnect }))
vi.mock('./mobile-relay-pairing-recovery', () => ({
  recoverMobileRelayPairing: (dependencies: unknown) => recoverMobileRelayPairing(dependencies)
}))

import { MobileRelayPairingRecoveryBridge } from './mobile-relay-pairing-recovery-bridge'

const HOST: HostProfile = {
  id: 'host-1',
  name: 'Host 1',
  endpoint: 'ws://127.0.0.1:1',
  deviceToken: 'replacement-token',
  publicKeyB64: 'key',
  lastConnected: 0
}

describe('MobileRelayPairingRecoveryBridge', () => {
  it('reconnects an open host with the exact recovered profile', async () => {
    recoverMobileRelayPairing.mockImplementationOnce(async ({ onHostPublished }) => {
      onHostPublished(HOST)
      return 'recovered'
    })
    let renderer: ReactTestRenderer | null = null

    await act(async () => {
      renderer = create(createElement(MobileRelayPairingRecoveryBridge))
      await Promise.resolve()
    })

    expect(forceReconnect).toHaveBeenCalledWith(HOST.id, HOST)
    act(() => renderer?.unmount())
  })
})
