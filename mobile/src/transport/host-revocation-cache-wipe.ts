import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

type RevocationSignals = Pick<
  StableLogicalRpcClient,
  'getState' | 'onStateChange' | 'getActivePath' | 'isPairingRejected' | 'onConnectionPathChange'
>

// Definite only: a relay session reports auth-failed on one E2EE refusal, which its latch counts first.
function isRevoked(client: RevocationSignals): boolean {
  return (
    client.isPairingRejected() ||
    (client.getState() === 'auth-failed' && client.getActivePath() !== 'relay')
  )
}

/** Wipes the host's cached screens each time the desktop is found to have revoked this phone (K6). */
export function wipeCacheOnRevocation(client: RevocationSignals, wipe: () => void): () => void {
  let revoked = isRevoked(client)
  if (revoked) {
    wipe()
  }
  const check = (): void => {
    const next = isRevoked(client)
    if (next && !revoked) {
      wipe()
    }
    revoked = next
  }
  const stopState = client.onStateChange(check)
  const stopPath = client.onConnectionPathChange(check)
  return () => {
    stopState()
    stopPath()
  }
}
