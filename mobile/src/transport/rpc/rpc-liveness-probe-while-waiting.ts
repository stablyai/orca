import { DECISIVE_PROBE_TIMEOUT_MS } from './rpc-session-liveness-watchdog'
import type { RpcClient } from './rpc-client-contract'

// A reply this late, with nothing heard meanwhile, means a silently dead connection (a sleeping desktop still reads connected); probe now, not after the idle watchdog, and keep asking until it settles.
export function probeLivenessWhileWaiting<T>(client: RpcClient, pending: Promise<T>): Promise<T> {
  const overdue = setInterval(() => client.probeLivenessNow?.(), DECISIVE_PROBE_TIMEOUT_MS)
  return pending.finally(() => clearInterval(overdue))
}
