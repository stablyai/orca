import type { AgentSessionRunDaemon } from '../../../../shared/agent-session/lifecycle/agent-session-run-placement'
import {
  KeptProviderRelayEndedError,
  KeptProviderRelayUnreachableError,
  keptProviderRelay,
  type KeptProviderRelay
} from '../../../provider-relay/app-provider-relays'
import { providerRelayRunGate } from '../../../provider-relay/provider-relay-run-liveness'
import { providerRelayRebinding } from '../../../provider-relay/provider-relay-kept-rebind'
import { providerRelayPlacedRunOf } from '../../../provider-relay/provider-relay-placed-records'

/** A chat's last run on a shared server: which relay and daemon start, and its commands' tag. */
export type CodexPooledRun = { relayId: string; daemon: AgentSessionRunDaemon; workload: string }

/** Where a relayed shared server runs, for its chats' run placements. */
export type CodexPooledServerPlacement = { relayId: string; daemon: AgentSessionRunDaemon }

/** Only a pooled run records the lease's tag; a chat's own relayed run never does. */
export function codexPooledRunOf(sessionId: string): CodexPooledRun | null {
  const run = providerRelayPlacedRunOf(sessionId)
  const workload = run?.placement.workload
  return run && workload
    ? { relayId: run.placement.relayId, daemon: run.placement.daemon, workload }
    : null
}

/**
 * The chat's pooled run as only its daemon start answers it: kept (its relay, now listed for this
 * chat), or gone (null). One that may run but can't be reached refuses the start, as a chat's own
 * kept agent does, so no second writer starts beside it.
 */
export async function codexPooledRunGate(sessionId: string): Promise<KeptProviderRelay | null> {
  const verdict = await providerRelayRunGate(sessionId, 'gone')
  if (verdict === 'gone') {
    if (providerRelayRebinding(sessionId)) {
      throw new KeptProviderRelayEndedError(sessionId)
    }
    return null
  }
  const kept = verdict === 'kept' ? keptProviderRelay(sessionId) : undefined
  if (!kept) {
    throw new KeptProviderRelayUnreachableError(sessionId)
  }
  return kept
}

/** The launch key a shared server's relay was named with (`codex-pool:<key>:<id>`). */
export function codexSharedRelayServerKey(chatKey: string): string | null {
  const [prefix, key] = chatKey.split(':')
  return prefix === 'codex-pool' && key ? key : null
}
