import { describe, expect, it } from 'vitest'
import type { HostProfile } from '../host-profile'
import { filterHostsByQuery } from './use-connected-host-picker'

function host(id: string, name: string, endpoint: string): HostProfile {
  return {
    id,
    name,
    endpoint,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected: 1
  }
}

const desk = host('desk', 'Desk', 'ws://192.0.2.2:6768')
const laptop = host('laptop', 'Laptop', 'wss://relay.example.com/mobile')
const server = host('server', 'Server', 'wss://ssh.example.com/mobile')

describe('filterHostsByQuery', () => {
  it('keeps desktops whose name or endpoint holds every typed word', () => {
    const hosts = [desk, laptop, server]
    expect(filterHostsByQuery(hosts, '  ')).toEqual(hosts)
    expect(filterHostsByQuery(hosts, 'lap')).toEqual([laptop])
    expect(filterHostsByQuery(hosts, 'ssh')).toEqual([server])
    expect(filterHostsByQuery(hosts, 'server relay')).toEqual([])
  })
})
