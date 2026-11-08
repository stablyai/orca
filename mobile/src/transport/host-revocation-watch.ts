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

/** Reports whether the desktop has revoked this phone (K6): now, then on each change. */
export function watchHostRevocation(
  client: RevocationSignals,
  onChange: (revoked: boolean) => void
): () => void {
  let revoked = isRevoked(client)
  onChange(revoked)
  const check = (): void => {
    const next = isRevoked(client)
    if (next !== revoked) {
      revoked = next
      onChange(next)
    }
  }
  const stopState = client.onStateChange(check)
  const stopPath = client.onConnectionPathChange(check)
  return () => {
    stopState()
    stopPath()
  }
}
