import { describe, expect, it } from 'vitest'
import type { DeviceEntry } from '../device-entry'
import { RelayedRuntimeClients } from './relayed-runtime-clients'

const client = (deviceId: string, lastSeenAt: number): DeviceEntry => ({
  deviceId,
  name: deviceId,
  scope: 'runtime',
  pairedAt: 0,
  lastSeenAt
})

describe('RelayedRuntimeClients', () => {
  it('lists the live client first, then the most recent, so stale browser sessions lose the sync cap', () => {
    const clients = new RelayedRuntimeClients()
    for (const deviceId of ['stale', 'live', 'recent']) {
      clients.add('env-1', deviceId)
    }
    const devices = [client('stale', 1), client('live', 2), client('recent', 3)]
    const listed = clients.listFor('env-1', devices, (deviceId) => deviceId === 'live')
    expect(listed.map((device) => device.deviceId)).toEqual(['live', 'recent', 'stale'])
  })

  it('enrolls a client only on the server it relayed to', () => {
    const clients = new RelayedRuntimeClients()
    clients.add('env-1', 'laptop')
    expect(clients.listFor('env-2', [client('laptop', 1)], () => true)).toEqual([])
    expect(clients.forget(['laptop'])).toBe(true)
    expect(clients.listFor('env-1', [client('laptop', 1)], () => true)).toEqual([])
    expect(clients.forget(['laptop'])).toBe(false)
  })
})
