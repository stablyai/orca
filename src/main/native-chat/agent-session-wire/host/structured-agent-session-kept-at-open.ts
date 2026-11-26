import {
  keptRunningProviderRelayPid,
  listProviderRelaysAtLaunchWithin,
  providerRelayMayKeepChat
} from '../../../provider-relay/app-provider-relays'
import { probeAgentSessionProcessIdentity } from '../../../runtime/agent-session/ownership/agent-session-process-identity-probe'
import { readEchoedAgentSessionSpawnToken } from '../../../runtime/agent-session/ownership/agent-session-spawn-token-readback'
import {
  noteProviderRelayKeptUnverified,
  providerRelayProviderOpensEnded
} from '../../../provider-relay/provider-relay-launch-inventory'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionProcessIdentity } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import {
  restoreJournalSqlFailure,
  type JournalWriterSettled
} from '../../agent-session-journal/journal-sql-failure'

/** The owner whose death may settle a kept open: none when the ended agent still opens to replay. */
export function keptOpenProvableOwner(
  record: Pick<AgentSessionConversationView, 'provider' | 'ownerObservation'> | null | undefined
): AgentSessionProcessIdentity | null {
  return record && !providerRelayProviderOpensEnded(record.provider)
    ? record.ownerObservation.ownerProcess
    : null
}

/** Gone, or its pid now names another process: pid reuse never keeps a dead chat's last run. */
export async function ownerProvenGone(owner: AgentSessionProcessIdentity): Promise<boolean> {
  const probe = await probeAgentSessionProcessIdentity({
    identity: owner,
    deps: { readEchoedSpawnToken: readEchoedAgentSessionSpawnToken }
  }).catch(() => null)
  return probe?.outcome === 'pid-absent' || probe?.outcome === 'identity-mismatch'
}

/** A chat's history never waits long on a late terminal host; its first send waits instead. */
const KEPT_LISTING_OPEN_WAIT_MS = 1_500

/**
 * Whether the last run's agent may still run under the terminal host, so its open settles nothing.
 * Only proof ends it: a complete listing without it, or its owner process gone (unless its ended
 * agent still opens, to replay what it left). A late listing is unknown, so the chat opens as kept
 * and reconciles once the listing answers, even with no owner.
 */
export async function structuredAgentSessionKeptAtOpen(
  record: Pick<
    AgentSessionConversationView,
    'sessionId' | 'provider' | 'location' | 'ownerObservation' | 'neverStarted'
  >,
  waitMs = KEPT_LISTING_OPEN_WAIT_MS
): Promise<boolean> {
  const { sessionId, provider, location } = record
  const owner = record.ownerObservation.ownerProcess
  if (!providerRelayMayKeepChat(provider, location.executionHostId === LOCAL_EXECUTION_HOST_ID)) {
    return false
  }
  const listed = await listProviderRelaysAtLaunchWithin(waitMs)
  // A listed kept relay is proof enough, even after launch recovery released the recorded owner.
  if (keptRunningProviderRelayPid(sessionId) !== null) {
    return true
  }
  if (listed) {
    return false
  }
  // An ended agent that still opens leaves output to replay, and an owner released without proof
  // (launch recovery) leaves only the listing to prove it gone.
  const gone = owner
    ? keptOpenProvableOwner(record) !== null && (await ownerProvenGone(owner))
    : record.neverStarted || record.ownerObservation.deathEvidence !== null
  if (gone) {
    return false
  }
  noteProviderRelayKeptUnverified(sessionId)
  return true
}

/**
 * The open recovery a kept open skipped: handed-over sends become unknown, and a stopped queue awaits
 * reopen from the open's own boundary, so a Resume pressed since then still stands.
 */
export async function recoverStructuredAgentSessionKeptOpen(
  journal: Pick<SqlAgentSessionJournal, 'write' | 'markQueueReopen'>,
  fence: number,
  openedSince: number
): Promise<void> {
  const commit = await journal.write({ kind: 'pending-unknown', fence })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pending-unknown returns settled ids or a serialized writer failure.
  const result = commit.value as JournalWriterSettled<unknown>
  if (result !== null && typeof result === 'object' && 'failure' in result) {
    throw restoreJournalSqlFailure(result.failure)
  }
  await journal.markQueueReopen(fence, openedSince)
}
