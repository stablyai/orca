// The one way a conversation's journal becomes open on this host: for a send, for a reader, and
// for an attach that finds none open.
//
// A damaged journal fails the open, which refuses it as unloadable. It marks what an earlier host
// process handed over and left unanswered as in doubt, and settles what it left running — the
// crash boundary. That
// needs no lease, and the doubt is final: whether the provider took such a row is never guessed. A
// row an earlier process accepted and never handed over (it quit or crashed first) is settled here
// too, before any reader, command or child sees it: a person's message is kept as a card, the rest
// rejected (`journal-unsent-send-hold.ts`). The cards then wait for the chat's next turn
// (`queued-message-pause.ts`). Nothing here starts a provider child.

import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { holdUnsentSends } from '../agent-session-journal/journal-unsent-send-hold'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  attachFingerprintFields,
  journalIdentityFor,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import { markStructuredQueueReopen } from './structured-agent-session-queued-pause'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export type OpenedStructuredAgentSessionConversation = {
  session: StructuredAgentSessionHostSession
}

export type StructuredAgentSessionConversationOpenDeps = {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'replacedRuntime'>
  journalDatabase: JournalHostDatabase
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
  const record = context.deps.store.getRecord(sessionId)
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
  record: AgentSessionRecord,
  options?: StructuredAgentSessionConversationOpenOptions
): Promise<OpenedStructuredAgentSessionConversation>
export async function openStructuredAgentSessionConversationJournal(
  deps: Omit<StructuredAgentSessionConversationOpenDeps, 'store'>,
  record: AgentSessionRecord,
  options: { acquisition: true }
): Promise<OpenedStructuredAgentSessionConversation>
export async function openStructuredAgentSessionConversationJournal(
  deps: Omit<StructuredAgentSessionConversationOpenDeps, 'store'> &
    Partial<Pick<StructuredAgentSessionConversationOpenDeps, 'store'>>,
  record: AgentSessionRecord,
  options: StructuredAgentSessionConversationOpenOptions = {}
): Promise<OpenedStructuredAgentSessionConversation> {
  const { sessionId } = record
  const fence = record.lease.runtimeFence
  const params = attachParamsForRecord(record, {
    clientOperationId: `read-restore:${sessionId}`,
    expectedRuntimeFence: fence
  })
  const identity = journalIdentityFor(record, params)
  const journal = await openAgentSessionJournal({ identity, database: deps.journalDatabase })
  try {
    // A handed-over row found here stays doubt: it reads as sent, and nothing narrows it later.
    await journal.markPendingSubmissionsUnknown(fence)
  } catch (error) {
    deps.logger.warn('marking pending sends unknown on open failed', {
      scope: 'open-pending-unknown',
      sessionId,
      error
    })
  }
  try {
    // Preserve leftover personal sends before any Stop can withdraw them.
    await holdUnsentSends(journal, { fence, hold: { cause: 'hostRestarted' } })
  } catch (error) {
    // Failed leftovers stay queued; delivery retries before handover or rejects all if recovery still fails.
    deps.logger.warn('settling sends an earlier process left queued failed on open', {
      scope: 'open-leftover-sends',
      sessionId,
      error
    })
  }
  // Mark after recovering cards; idle sweeping never closes handles while cards wait.
  await markStructuredQueueReopen(sessionId, journal, fence, deps.logger)
  // No local child writes unopened journals; settle the gone generation before readers/new children.
  if (!options.acquisition) {
    await settleGoneGeneration(deps, record, journal)
  }
  return { session: { journal, params, child: null } }
}

/** New released-owner death proof can refine prior unverifiable work; no-op after revision. */
export async function resettleOpenStructuredAgentSessionConversation(
  deps: StructuredAgentSessionConversationOpenDeps,
  sessionId: string,
  session: StructuredAgentSessionHostSession | undefined
): Promise<void> {
  const record = deps.store.getRecord(sessionId)
  if (session && record?.lease.deathEvidence) {
    await settleGoneGeneration(deps, record, session.journal)
  }
}

async function settleGoneGeneration(
  deps: Pick<StructuredAgentSessionConversationOpenDeps, 'logger'> &
    Partial<Pick<StructuredAgentSessionConversationOpenDeps, 'store'>>,
  record: AgentSessionRecord,
  journal: AgentSessionJournal
): Promise<void> {
  try {
    await settleStaleStructuredAgentSessionState({
      journal,
      sessionId: record.sessionId,
      fence: record.lease.runtimeFence,
      acquisitionGeneration: null,
      deathEvidence: record.lease.deathEvidence ?? null,
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
  record: AgentSessionRecord,
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
