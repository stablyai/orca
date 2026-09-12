import { describe, expect, it } from 'vitest'
import type { HostProfile } from './types'
import {
  HOME_AUTO_CONNECT_LIMIT,
  resolveHomeHostConnectionState,
  selectHomeAutoConnectHostIds
} from './home-host-auto-connect'

function host(id: string, lastConnected: number, credentials = true): HostProfile {
  return {
    id,
    name: id,
    endpoint: `ws://${id}`,
    deviceToken: credentials ? `token-${id}` : '',
    publicKeyB64: credentials ? `key-${id}` : '',
    lastConnected
  }
}

describe('home host auto-connect', () => {
  it('limits startup connections to the most recently used credentialed hosts', () => {
    const hosts = [
      host('old', 1),
      host('newest', 5),
      host('second', 4),
      host('third', 3),
      host('fourth', 2),
      host('missing-credentials', 6, false)
    ]

    expect(selectHomeAutoConnectHostIds(hosts)).toEqual(['newest', 'second', 'third'])
    expect(selectHomeAutoConnectHostIds(hosts)).toHaveLength(HOME_AUTO_CONNECT_LIMIT)
  })

  it('does not mutate the host card order', () => {
    const hosts = [host('old', 1), host('new', 2)]

    selectHomeAutoConnectHostIds(hosts)

    expect(hosts.map((item) => item.id)).toEqual(['old', 'new'])
  })

  it('only presents hosts in the startup subset as connecting before clients open', () => {
    const autoConnectHostIds = ['recent']

    expect(resolveHomeHostConnectionState('recent', undefined, autoConnectHostIds)).toBe(
      'connecting'
    )
    expect(resolveHomeHostConnectionState('stale', undefined, autoConnectHostIds)).toBe(
      'disconnected'
    )
    expect(resolveHomeHostConnectionState('stale', 'connected', autoConnectHostIds)).toBe(
      'connected'
    )
  })
})
