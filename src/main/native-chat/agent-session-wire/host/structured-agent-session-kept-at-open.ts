import {
  keptRunningProviderRelayPid,
  listProviderRelaysAtLaunchWithin,
  noteProviderRelayKeptUnverified,
  processProvenGone,
  providerRelayKeptFromLastRun,
  providerRelayKeptUnverified,
  providerRelayListingSettled,
  providerRelayMayKeepChat
} from '../../../provider-relay/app-provider-relays'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'

/** A chat's history never waits long on a late terminal host; its first send waits instead. */
const KEPT_LISTING_OPEN_WAIT_MS = 1_500

/**
 * Whether the last run's agent may still run under the terminal host, so its open settles nothing.
 * Only proof ends it: a complete listing without it, or its owner process gone. A late listing is
 * unknown, so the chat opens as kept and reconciles once the listing answers.
 */
export async function structuredAgentSessionKeptAtOpen(
  record: Pick<
    AgentSessionConversationView,
    'sessionId' | 'provider' | 'location' | 'ownerObservation'
  >,
  waitMs = KEPT_LISTING_OPEN_WAIT_MS
): Promise<boolean> {
  const { sessionId, provider, location } = record
  const owner = record.ownerObservation.ownerProcess
  if (
    !owner ||
    !providerRelayMayKeepChat(provider, location.executionHostId === LOCAL_EXECUTION_HOST_ID)
  ) {
    return false
  }
  const listed = await listProviderRelaysAtLaunchWithin(waitMs)
  if (listed || keptRunningProviderRelayPid(sessionId) !== null) {
    return keptRunningProviderRelayPid(sessionId) !== null
  }
  if (processProvenGone(owner.pid)) {
    return false
  }
  noteProviderRelayKeptUnverified(sessionId)
  return true
}

/** Once the late listing answers, a chat opened as kept whose agent wasn't kept settles as gone. */
export async function reconcileStructuredAgentSessionKeptAtOpen(
  sessionId: string,
  settleGone: () => Promise<void>
): Promise<void> {
  if (!providerRelayKeptUnverified(sessionId) || !(await providerRelayListingSettled())) {
    return
  }
  if (!providerRelayKeptFromLastRun(sessionId)) {
    await settleGone()
  }
}
