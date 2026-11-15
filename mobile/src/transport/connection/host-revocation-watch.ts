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

/**
 * Reports a revocation each time the desktop is found to have revoked this phone (K6), and its end only
 * once the phone authenticates again: a rebuilt client that is still dialing proves nothing.
 */
export function watchHostRevocation(
  client: RevocationSignals,
  onChange: (revoked: boolean) => void
): () => void {
  let revoked = false
  const check = (): void => {
    if (!revoked && isRevoked(client)) {
      revoked = true
      onChange(true)
    } else if (client.getState() === 'connected') {
      revoked = false
      onChange(false)
    }
  }
  check()
  const stopState = client.onStateChange(check)
  const stopPath = client.onConnectionPathChange(check)
  return () => {
    stopState()
    stopPath()
  }
}
