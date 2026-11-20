import { describe, expect, it } from 'vitest'
import { homeUnreachableHostIds } from './home-host-connection-projection'

const host = (id: string) => ({ id, name: id, endpoint: `ws://${id}.local:6768` })

describe('homeUnreachableHostIds', () => {
  it('counts a desktop Home never dials and one past its quiet retries, not one still dialing', () => {
    const unreachable = homeUnreachableHostIds(
      ['live', 'dialing', 'retrying', 'gave-up', 'not-dialed', 'refused'].map(host),
      {
        autoConnectHostIds: ['live', 'dialing', 'retrying', 'gave-up'],
        hostAttempts: { retrying: 1, 'gave-up': 4 },
        hostConnections: {},
        hostLastConnected: { live: 1 },
        hostStates: {
          live: 'connected',
          dialing: 'connecting',
          retrying: 'reconnecting',
          'gave-up': 'reconnecting',
          refused: 'auth-failed'
        }
      },
      10_000
    )
    expect(unreachable).toEqual(['gave-up', 'not-dialed', 'refused'])
  })
})
