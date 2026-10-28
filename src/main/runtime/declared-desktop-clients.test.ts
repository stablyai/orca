import { describe, expect, it } from 'vitest'
import type { DeviceEntry } from './device-entry'
import {
  DECLARED_CLIENT_RECONNECT_GRACE_MS,
  DeclaredDesktopClients
} from './declared-desktop-clients'

function devices(entries: Partial<DeviceEntry>[]) {
  const rows = entries.map((entry, index) => ({
    deviceId: `d${index}`,
    name: `Desk ${index}`,
    scope: 'runtime' as const,
    pairedAt: 1,
    lastSeenAt: 1,
    ...entry
  }))
  return (deviceId: string) => rows.find((row) => row.deviceId === deviceId) ?? null
}

describe('DeclaredDesktopClients', () => {
  it('counts each other installation once, never the caller’s own sockets', () => {
    let now = 1_000
    const clients = new DeclaredDesktopClients(() => now)
    clients.declare('c-stable', 'd0', 'stable')
    clients.declare('c-dev-1', 'd0', 'dev')
    clients.declare('c-dev-2', 'd0', 'dev')
    const getDevice = devices([{ name: 'Orca' }])
    expect(
      clients.peers({ connectionId: 'c-other', clientInstanceId: 'stable' }, getDevice)
    ).toEqual({ peers: [{ name: 'Orca' }] })
    // Without an id, the caller's own declared socket still identifies it.
    expect(clients.peers({ connectionId: 'c-stable' }, getDevice).peers).toHaveLength(1)
    clients.forget('c-dev-1')
    clients.forget('c-dev-2')
    now += DECLARED_CLIENT_RECONNECT_GRACE_MS
    expect(clients.peers({ connectionId: 'c-stable' }, getDevice).peers).toEqual([])
  })

  it('sanitizes names, hides startup-offer names, and skips rows that are no desktop', () => {
    const clients = new DeclaredDesktopClients()
    clients.declare('a', 'd0', 'one')
    clients.declare('b', 'd1', 'two')
    clients.declare('c', 'd2', 'three')
    clients.declare('d', 'gone', 'four')
    const getDevice = devices([
      { name: 'Orca\n‮Dev⁦' },
      { name: 'CLI 10/28/2026' },
      { name: 'Phone', scope: 'mobile' }
    ])
    expect(clients.peers({ connectionId: 'me', clientInstanceId: 'me' }, getDevice)).toEqual({
      peers: [{ name: 'OrcaDev' }, { name: 'another Orca' }]
    })
  })

  it('keeps the Orca of a closed control socket for a reconnect grace, then drops it', () => {
    let now = 1_000
    const clients = new DeclaredDesktopClients(() => now)
    const getDevice = devices([{ name: 'Orca Dev' }])
    clients.declare('dev-socket', 'd0', 'dev')
    clients.forget('dev-socket')
    expect(clients.peers({ connectionId: 'me', clientInstanceId: 'me' }, getDevice).peers).toEqual([
      { name: 'Orca Dev' }
    ])
    // A re-declare on a new socket takes over; closing it starts a fresh grace.
    now += DECLARED_CLIENT_RECONNECT_GRACE_MS - 1
    clients.declare('dev-socket-2', 'd0', 'dev')
    clients.forget('dev-socket-2')
    now += DECLARED_CLIENT_RECONNECT_GRACE_MS - 1
    expect(
      clients.peers({ connectionId: 'me', clientInstanceId: 'me' }, getDevice).peers
    ).toHaveLength(1)
    now += 1
    expect(clients.peers({ connectionId: 'me', clientInstanceId: 'me' }, getDevice).peers).toEqual(
      []
    )
  })

  it('starts the grace only when an Orca’s last declared socket closes', () => {
    let now = 1_000
    const clients = new DeclaredDesktopClients(() => now)
    const getDevice = devices([{ name: 'Orca Dev' }])
    const peers = () =>
      clients.peers({ connectionId: 'me', clientInstanceId: 'me' }, getDevice).peers
    clients.declare('a', 'd0', 'dev')
    clients.declare('b', 'd0', 'dev')
    const aClosed = now
    clients.forget('a')
    now += 30_000
    const bClosed = now
    clients.forget('b')
    // Counted from b's close, not a's: still listed when a's grace would have run out.
    now = aClosed + DECLARED_CLIENT_RECONNECT_GRACE_MS
    expect(peers()).toHaveLength(1)
    now = bClosed + DECLARED_CLIENT_RECONNECT_GRACE_MS
    expect(peers()).toEqual([])
  })

  it('sweeps expired graces on every close, even if nobody asks for peers', () => {
    let now = 1_000
    const clients = new DeclaredDesktopClients(() => now)
    for (let i = 0; i < 50; i += 1) {
      clients.declare(`socket-${i}`, 'd0', `install-${i}`)
      clients.forget(`socket-${i}`)
    }
    expect(clients.reconnectingCount).toBe(50)
    now += DECLARED_CLIENT_RECONNECT_GRACE_MS
    clients.declare('last', 'd0', 'install-last')
    clients.forget('last')
    expect(clients.reconnectingCount).toBe(1)
  })
})
