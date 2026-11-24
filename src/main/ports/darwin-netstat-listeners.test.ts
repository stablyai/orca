import { describe, expect, it } from 'vitest'
import { readDarwinNetstatListeners } from './darwin-netstat-listeners'

// Captured from macOS `netstat -Aaln -p tcp` (Socket and Flowhash columns) and `netstat -aln -p tcp`.
const WITH_SOCKETS = `Active Internet connections (including servers)
Socket           Flowhash Proto Recv-Q Send-Q  Local Address      Foreign Address    (state)
3673bf00525abde2 89771705 tcp4       0      0  127.0.0.1.1055                                127.0.0.1.54925                               ESTABLISHED
35c7919dae76f95c        0 tcp4       0      0  *.65413                                       *.*                                           LISTEN
56e0cd75d429ae99        0 tcp4       0      0  127.0.0.1.65411                               *.*                                           LISTEN
a25d8ce6dc3a91d4        0 tcp6       0      0  *.49152                                       *.*                                           LISTEN
`
const WITHOUT_SOCKETS = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  127.0.0.1.1055         127.0.0.1.54925        ESTABLISHED
tcp4       0      0  *.65413                *.*                    LISTEN
tcp4       0      0  127.0.0.1.65411        *.*                    LISTEN
tcp6       0      0  *.49152                *.*                    LISTEN
`

describe('readDarwinNetstatListeners', () => {
  it('reads the same listeners with socket columns and signs each socket identity', () => {
    const withSockets = readDarwinNetstatListeners(WITH_SOCKETS)
    expect(withSockets.ports).toEqual(readDarwinNetstatListeners(WITHOUT_SOCKETS).ports)
    expect(withSockets.ports).toHaveLength(3)
    expect(readDarwinNetstatListeners(WITHOUT_SOCKETS).socketSignature).toBeNull()

    // A listener rebound on the same port gets a new kernel socket, so the signature must change.
    const rebound = WITH_SOCKETS.replace('56e0cd75d429ae99', '56e0cd75d429ae9a')
    expect(readDarwinNetstatListeners(rebound).socketSignature).not.toBe(
      withSockets.socketSignature
    )
    // Connection churn alone must not change it.
    const churn = WITH_SOCKETS.replace('3673bf00525abde2 89771705', '1111bf00525abde2 12345678')
    expect(readDarwinNetstatListeners(churn).socketSignature).toBe(withSockets.socketSignature)
  })
})
