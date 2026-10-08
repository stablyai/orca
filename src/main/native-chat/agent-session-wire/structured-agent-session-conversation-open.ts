// The one way a conversation's journal becomes open on this host: for a send, for a reader, and
// for an attach that finds none open.
//
// A damaged journal fails the open, which refuses it as unloadable. It marks what an earlier host
// process handed over and left unanswered as in doubt, and settles what it left running — the
// crash boundary. That
// needs no lease: provider history decides such a row later, under a won lease, in the attach. A
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
import {
  markStructuredQueueReopen,
  structuredAgentSessionHostInstance
} from './structured-agent-session-queued-pause'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export type OpenedStructuredAgentSessionConversation = {
  session: StructuredAgentSessionHostSession
}

export type StructuredAgentSessionConversationOpenDeps = {
  store: Pick<AgentSessionRecordStore, 'getRecord'>
  journalDatabase: JournalHostDatabase
  logger: StructuredAgentSessionHostDeps['logger']
}

/** An acquisition's own open: its reserve cleared the record's death evidence, so it settles
 *  what the gone generation left running itself, from what it read before. */
export type StructuredAgentSessionConversationOpenOptions = {
  acquisition?: boolean
}

export type StructuredAgentSessionConversationOpenContext = {
  deps: StructuredAgentSessionConversationOpenDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  /** Indexes a conversation that just became open; the host publishes it and wakes delivery. */
  adoptOpened: (
    sessionId: string,
    opened: OpenedStructuredAgentSessionConversation
  ) => Promise<void>
}

/** The open conversation, or null when this host has no record of it. For a caller inside the
 *  session's serialize, which is what makes "not open yet" exact. */
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

/** The open itself, indexed by nobody yet: the caller adopts the result. */
export async function openStructuredAgentSessionConversationJournal(
  deps: Omit<StructuredAgentSessionConversationOpenDeps, 'store'>,
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
    // A handed-over row found here is only doubt, which provider history decides under a won lease.
    await journal.markPendingSubmissionsUnknown(fence)
  } catch (error) {
    deps.logger.warn('marking pending sends unknown on open failed', {
      scope: 'open-pending-unknown',
      sessionId,
      error
    })
  }
  try {
    // Before a Stop this open serves can withdraw one: a Stop never withdraws a card.
    await holdUnsentSends(journal, {
      fence,
      hostInstance: structuredAgentSessionHostInstance(),
      hold: { cause: 'hostRestarted' }
    })
  } catch (error) {
    // The row stays queued. The delivery loop's first step tries again before it hands anything
    // over; if that fails too, the loop fails and rejects every queued send.
    deps.logger.warn('settling sends an earlier process left queued failed on open', {
      scope: 'open-leftover-sends',
      sessionId,
      error
    })
  }
  // After the leftovers became cards, so the mark follows every card this open found. Every open
  // comes after the chat stopped running: the idle sweep never closes one with cards waiting.
  await markStructuredQueueReopen(sessionId, journal, fence, deps.logger)
  // No child in this process writes to a journal nobody had open, so whatever it shows running
  // belongs to a generation that is gone, whatever the lease still claims. Settled before any
  // reader or child sees it.
  if (!options.acquisition) {
    await settleGoneGeneration(deps, record, journal)
  }
  return { session: { journal, params, child: null } }
}

/**
 * The open's settle again, for a conversation already open: a proof of death written since it
 * opened (the startup reconcile, a recovery) revises what the open could only call `unverifiable`.
 * A record holds a proof only while released, so no child here is writing. A no-op once revised.
 */
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
  deps: Pick<StructuredAgentSessionConversationOpenDeps, 'logger'>,
  record: AgentSessionRecord,
  journal: AgentSessionJournal
): Promise<void> {
  try {
    await settleStaleStructuredAgentSessionState({
      journal,
      sessionId: record.sessionId,
      fence: record.lease.runtimeFence,
      acquisitionGeneration: null,
      deathEvidence: record.lease.deathEvidence ?? null
    })
  } catch (error) {
    // Best effort: the next open or acquire re-derives it.
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
