import { prWatchStorage } from '../../../github/pr-watch/pr-watch-storage'
// Open and settle the crash boundary before any reader, command or child: damaged journals fail;
// handed-over sends remain permanently unknown. Unhanded personal text becomes a paused card,
// other unhanded sends are rejected (journal-unsent-send-hold.ts / queued-message-pause.ts).
// Settlement needs no lease and starts no provider child.

import type { JournalSqlDatabase } from '../../agent-session-journal/database/journal-sql-database'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../../agent-session-journal/journal-store-factory'
import { restoreJournalSqlFailure } from '../../agent-session-journal/journal-sql-failure'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { UsageLimitContinueIdentity } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-usage-limit-continue'
import {
  attachFingerprintFields,
  journalIdentityFor,
  type AgentSessionAttachParams
} from '../acquisition/structured-agent-session-attach'
import { deliverPendingPullRequestEvents } from '../../../github/pr-watch/pr-event-delivery'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import '../termination/structured-agent-session-dead-generation-settlement'
import { settleStaleStructuredAgentSessionState } from '../termination/structured-agent-session-stale-state-settlement'
import { structuredAgentSessionFailureWordsContext } from '../operations/structured-agent-session-send-preparation'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export type OpenedStructuredAgentSessionConversation = {
  session: StructuredAgentSessionHostSession
}

export type StructuredAgentSessionConversationOpenDeps = {
  store: Pick<
    AgentSessionRecordStore,
    'getConversation' | 'replacedRuntime' | 'usageLimitContinueCancelReceipt'
  >
  journalDatabase: JournalSqlDatabase
  logger: StructuredAgentSessionHostDeps['logger']
}

/** Acquisition retains prior death evidence because reservation clears it. */
export type StructuredAgentSessionConversationOpenOptions = {
  acquisition?: boolean
}

export type StructuredAgentSessionConversationOpenContext = {
  deps: StructuredAgentSessionConversationOpenDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  adoptOpened: (
    sessionId: string,
    opened: OpenedStructuredAgentSessionConversation
  ) => Promise<void>
}

/** Caller holds serialization so the open-or-absent decision is exact. */
export async function openStructuredAgentSessionConversation(
  context: StructuredAgentSessionConversationOpenContext,
  sessionId: string,
  options: StructuredAgentSessionConversationOpenOptions = {}
): Promise<StructuredAgentSessionHostSession | null> {
  const open = context.sessions.get(sessionId)
  if (open) {
    return open
  }
  const record = context.deps.store.getConversation(sessionId)
  if (!record) {
    return null
  }
  const opened = await openStructuredAgentSessionConversationJournal(context.deps, record, options)
  await context.adoptOpened(sessionId, opened)
  return opened.session
}

/** Caller adopts the unindexed journal; settlement needs store ownership history. */
export async function openStructuredAgentSessionConversationJournal(
  deps: StructuredAgentSessionConversationOpenDeps,
  record: AgentSessionConversationView,
  options?: StructuredAgentSessionConversationOpenOptions
): Promise<OpenedStructuredAgentSessionConversation>
export async function openStructuredAgentSessionConversationJournal(
  deps: Omit<StructuredAgentSessionConversationOpenDeps, 'store'>,
  record: AgentSessionConversationView,
  options: { acquisition: true }
): Promise<OpenedStructuredAgentSessionConversation>
export async function openStructuredAgentSessionConversationJournal(
  deps: Omit<StructuredAgentSessionConversationOpenDeps, 'store'> &
    Partial<Pick<StructuredAgentSessionConversationOpenDeps, 'store'>>,
  record: AgentSessionConversationView,
  options: StructuredAgentSessionConversationOpenOptions = {}
): Promise<OpenedStructuredAgentSessionConversation> {
  const { sessionId } = record
  const fence = record.currentFence
  const params = attachParamsForRecord(record, {
    clientOperationId: `read-restore:${sessionId}`,
    expectedRuntimeFence: fence
  })
  const identity = journalIdentityFor(record, params)
  const { store } = deps
  const journal = await openAgentSessionJournal({
    identity,
    database: deps.journalDatabase,
    recover: { fence },
    onRecoveryFailure: ({ step, failure }) => {
      const messages = {
        'pending-unknown': 'marking pending sends unknown on open failed',
        'hold-unsent': 'settling sends an earlier process left queued failed on open',
        'withdraw-derived': 'withdrawing replaced restart work failed on open',
        'queue-reopen': 'marking a reopened queue failed'
      }
      deps.logger.warn(messages[step], {
        scope: `open-${step}`,
        sessionId,
        error: restoreJournalSqlFailure(failure)
      })
    },
    // Without a record store (acquisition-only opens) there is no continuation to withdraw.
    ...(store
      ? {
          withdrawStoppedCut: (cut: UsageLimitContinueIdentity) =>
            store.usageLimitContinueCancelReceipt(sessionId, cut)
        }
      : {})
  })
  // No local child writes unopened journals; settle the gone generation before readers/new children.
  if (!options.acquisition) {
    await settleGoneGeneration(deps, record, journal)
  }
  try {
    // CI lines that landed while the chat was closed go in before any new turn can start.
    await deliverPendingPullRequestEvents({
      database: prWatchStorage(deps.journalDatabase),
      journal,
      sessionId,
      fence
    })
  } catch (error) {
    deps.logger.warn('appending CI lines on open failed', {
      scope: 'open-pr-events',
      sessionId,
      error
    })
  }
  return { session: { journal, params, child: null } }
}

/** New released-owner death proof can refine prior unverifiable work; no-op after revision. */
export async function resettleOpenStructuredAgentSessionConversation(
  deps: StructuredAgentSessionConversationOpenDeps,
  sessionId: string,
  session: StructuredAgentSessionHostSession | undefined
): Promise<void> {
  const record = deps.store.getConversation(sessionId)
  if (session && record?.ownerObservation.deathEvidence) {
    await settleGoneGeneration(deps, record, session.journal)
  }
}

async function settleGoneGeneration(
  deps: Pick<StructuredAgentSessionConversationOpenDeps, 'logger'> &
    Partial<Pick<StructuredAgentSessionConversationOpenDeps, 'store'>>,
  record: AgentSessionConversationView,
  journal: AgentSessionJournal
): Promise<void> {
  try {
    await settleStaleStructuredAgentSessionState({
      journal,
      sessionId: record.sessionId,
      fence: record.currentFence,
      acquisitionGeneration: null,
      deathEvidence: record.ownerObservation.deathEvidence ?? null,
      replaced: deps.store?.replacedRuntime(record.sessionId),
      failureTextContext: structuredAgentSessionFailureWordsContext(record)
    })
  } catch (error) {
    // Best effort; next open/acquisition retries.
    deps.logger.warn("settling a gone agent's work on open failed", {
      scope: 'open-dead-generation',
      sessionId: record.sessionId,
      error
    })
  }
}

export function attachParamsForRecord(
  record: Pick<AgentSessionConversationView, 'sessionId' | 'location' | 'provider' | 'accountHome'>,
  input: {
    clientOperationId: string
    expectedRuntimeFence: number
  }
): AgentSessionAttachParams {
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: record.sessionId,
      clientOperationId: input.clientOperationId,
      expectedRuntimeFence: input.expectedRuntimeFence,
      payloadFingerprint: ''
    },
    location: record.location,
    provider: record.provider,
    agent: record.provider,
    accountHome: record.accountHome,
    runtimeKind: 'native'
  }
  return {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: record.sessionId,
        fields: attachFingerprintFields(params)
      })
    }
  }
}
