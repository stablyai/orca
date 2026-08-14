import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'

export function relayStructuredFailures(
  consecutiveFailures: number,
  session: MobileRelayRpcSession | null
): number {
  const signal = session?.consumeStructuredReconnectSignal?.()
  const resetFailures = signal?.streamLongevityConfirmed ? 0 : consecutiveFailures
  return signal?.backgroundRestart ? Math.max(1, resetFailures) : resetFailures
}
