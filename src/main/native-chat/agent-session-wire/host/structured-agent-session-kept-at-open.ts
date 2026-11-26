import {
  keptRunningProviderRelayPid,
  listProviderRelaysAtLaunchWithin,
  noteProviderRelayKeptUnverified,
  providerRelayMayKeepChat
} from '../../../provider-relay/app-provider-relays'
import { probeAgentSessionProcessIdentity } from '../../../runtime/agent-session/ownership/agent-session-process-identity-probe'
import { readEchoedAgentSessionSpawnToken } from '../../../runtime/agent-session/ownership/agent-session-spawn-token-readback'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionProcessIdentity } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import {
  restoreJournalSqlFailure,
  type JournalWriterSettled
} from '../../agent-session-journal/journal-sql-failure'

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
  if (await ownerProvenGone(owner)) {
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
