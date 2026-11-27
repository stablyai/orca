import {
  CODEX_STRUCTURED_HANDLE_NAMESPACE,
  isAgentSessionProviderHandleInNamespace
} from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionRunDaemon } from '../../../../shared/agent-session/lifecycle/agent-session-run-placement'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  KeptProviderRelayEndedError,
  KeptProviderRelayUnreachableError,
  keptProviderRelay,
  type KeptProviderRelay
} from '../../../provider-relay/app-provider-relays'
import {
  providerRelayRunGate,
  providerRelayRunLiveness
} from '../../../provider-relay/provider-relay-run-liveness'
import { providerRelayRebinding } from '../../../provider-relay/provider-relay-kept-rebind'
import {
  providerRelayPlacedRun,
  providerRelayPlacedRunOf,
  providerRelayRunsPlacedOn
} from '../../../provider-relay/provider-relay-placed-records'
import { forgetListedProviderRelayChat } from '../../../provider-relay/provider-relay-launch-inventory'
import type { CodexRecoveredChat } from './codex-shared-recovery-group'

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

function codexThreadOf(record: AgentSessionRecord): string | null {
  const handle = record.providerHandleChain.at(-1)?.handle
  return handle &&
    isAgentSessionProviderHandleInNamespace(handle, CODEX_STRUCTURED_HANDLE_NAMESPACE)
    ? handle.nativeId
    : null
}

/** The pooled run a chat's record names (before deletion forgets it), with its daemon's say. */
export function codexRecordPooledRun(record: AgentSessionRecord): CodexPooledRun | null {
  const placed = providerRelayPlacedRun(record)
  const workload = placed?.placement.workload
  return placed && workload && codexThreadOf(record)
    ? { relayId: placed.placement.relayId, daemon: placed.placement.daemon, workload }
    : null
}

/**
 * A deleted chat's pooled run as its daemon start answers it, asked fresh: kept (its relay, now
 * listed for this one ask), gone, or unknown (it may run and can't be reached).
 */
export async function codexDeletedPooledRelay(
  record: AgentSessionRecord
): Promise<KeptProviderRelay | 'gone' | 'unknown'> {
  const verdict = await providerRelayRunLiveness(record, { fresh: true }).catch(() => 'unknown')
  const relay = keptProviderRelay(record.sessionId)
  forgetListedProviderRelayChat(record.sessionId)
  return verdict === 'gone' ? 'gone' : verdict === 'kept' && relay ? relay : 'unknown'
}

/** The chats a kept server still carries: each record whose current run names its relay. Every
 *  one, however many: leaving a live owner out would let its chat start a second writer. */
export function codexExpectedChats(relayId: string): CodexRecoveredChat[] {
  return providerRelayRunsPlacedOn(relayId).flatMap(({ record, placement }) => {
    const threadId = codexThreadOf(record)
    return threadId && placement.workload
      ? [{ sessionId: record.sessionId, threadId, workload: placement.workload }]
      : []
  })
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
