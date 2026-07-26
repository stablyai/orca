import { describe, expect, it, vi } from 'vitest'
import { MobileRelayDirectUpgradeController } from './mobile-relay-direct-upgrade-controller'
import type { MobileRelayDirectUpgradeResult } from './mobile-relay-direct-upgrade'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionState, HostProfile } from './types'

const directHost: HostProfile = {
  id: 'host-direct',
  name: 'Host 4',
  endpoint: 'ws://192.168.1.2:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'A'.repeat(44),
  lastConnected: 1
}

const upgraded = {
  host: {
    ...directHost,
    relayHostId: 'AbCdEf0123_-xyZ9',
    relay: {
      v: 1 as const,
      directorUrl: 'https://relay-staging.onorca.dev',
      cellUrl: 'https://c1.relay-staging.onorca.dev',
      assignmentEpoch: 4,
      relayHostId: 'AbCdEf0123_-xyZ9',
      e2eeFraming: 2 as const
    }
  },
  bundle: {
    v: 1 as const,
    hostId: directHost.id,
    deviceToken: directHost.deviceToken,
    current: {
      token: 'A'.repeat(43),
      hash: 'B'.repeat(43),
      version: 1,
      expiresAt: 99_999_999
    }
  }
} satisfies MobileRelayDirectUpgradeResult

function logicalClient(initial: ConnectionState) {
  let state = initial
  const listeners = new Set<(state: ConnectionState) => void>()
  return {
    client: {
      getState: () => state,
      onStateChange: (listener: (next: ConnectionState) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    } as unknown as StableLogicalRpcClient,
    setState(next: ConnectionState) {
      state = next
      for (const listener of listeners) {
        listener(next)
      }
    }
  }
}

describe('direct pairing upgrade controller', () => {
  it('upgrades immediately after an authenticated direct connection', async () => {
    const logical = logicalClient('connected')
    const upgrade = vi.fn(async () => upgraded)
    const onUpgraded = vi.fn(async () => {})
    const controller = new MobileRelayDirectUpgradeController(logical.client, directHost, {
      upgrade,
      onUpgraded
    })

    await controller.start()

    expect(upgrade).toHaveBeenCalledWith(logical.client, directHost)
    expect(onUpgraded).toHaveBeenCalledWith(upgraded)
  })

  it('retries a deferred upgrade on the next foreground transition', async () => {
    const logical = logicalClient('connected')
    const upgrade = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(upgraded)
    const onUpgraded = vi.fn(async () => {})
    const controller = new MobileRelayDirectUpgradeController(logical.client, directHost, {
      upgrade,
      onUpgraded
    })

    await controller.start()
    controller.setForeground(false)
    controller.setForeground(true)
    await vi.waitFor(() => expect(onUpgraded).toHaveBeenCalledOnce())

    expect(upgrade).toHaveBeenCalledTimes(2)
  })

  it('fences a completed request after the host client closes', async () => {
    const logical = logicalClient('connecting')
    let resolveUpgrade!: (result: MobileRelayDirectUpgradeResult) => void
    const upgrade = vi.fn(
      () =>
        new Promise<MobileRelayDirectUpgradeResult>((resolve) => {
          resolveUpgrade = resolve
        })
    )
    const onUpgraded = vi.fn(async () => {})
    const controller = new MobileRelayDirectUpgradeController(logical.client, directHost, {
      upgrade,
      onUpgraded
    })
    await controller.start()

    logical.setState('connected')
    controller.stop()
    resolveUpgrade(upgraded)
    await Promise.resolve()

    expect(onUpgraded).not.toHaveBeenCalled()
  })
})
