// The one way a conversation's journal becomes open on this host: for a send, for a reader, and
// for an attach that finds none open.
//
// It opens with recovery, so an unusable journal is rebuilt rather than refused, and it appends
// the chat's open settlement plan (structured-agent-session-open-settlement.ts): what an earlier
// host process handed over and left unanswered becomes doubt, what it accepted and never handed
// over is rejected, and what it left running is settled — the crash boundary. That needs no lease:
// provider history decides a doubtful row later, under a won lease, in the attach. Nothing here
// starts a provider child. The plan's appends keep the chat's stored state current, and the open
// re-derives it when something else (an older build, an import, a repair) left it behind.

import type { AgentJournalResetReason } from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import type { JournalLoad } from '../agent-session-journal/journal-open'
import { openAgentSessionJournalWithRecovery } from './agent-session-journal-recovery'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  attachFingerprintFields,
  journalIdentityFor,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  appendGoneGenerationSettlement,
  appendOpenSettlement,
  planOpenSettlement,
  type OpenSettlementRecordFacts
} from './structured-agent-session-open-settlement'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export type OpenedStructuredAgentSessionConversation = {
  session: StructuredAgentSessionHostSession
  /** Set when the journal was rebuilt on the way; readers reload from a snapshot. */
  reset: AgentJournalResetReason | null
}

export type StructuredAgentSessionConversationOpenDeps = {
  store: Pick<AgentSessionRecordStore, 'getRecord'>
  adapter: Pick<StructuredAgentSessionAdapter, 'historyFilePath'>
  journalDatabase: JournalHostDatabase
  logger: StructuredAgentSessionHostDeps['logger']
}

/** An acquisition's own open: its reserve cleared the record's death evidence, so it settles
 *  what the gone generation left running itself, from what it read before. */
export type StructuredAgentSessionConversationOpenOptions = {
  acquisition?: boolean
  /** A restore's open, which copies no per-chat file: see `AgentSessionJournal.whenImported`. */
  deferPerSessionImport?: boolean
  /** The chat as a background copy just folded it, in place of the open's replay. */
  loaded?: JournalLoad
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
  const opened = await openAgentSessionJournalWithRecovery({
    identity,
    database: deps.journalDatabase,
    fence,
    historyFilePath: (await deps.adapter.historyFilePath?.({ identity })) ?? null,
    deferPerSessionImport: options.deferPerSessionImport,
    ...(options.loaded ? { loaded: options.loaded } : {}),
    // The fence the status feed reads, which a child's end moves after this open.
    currentFence: () => deps.store?.getRecord(sessionId)?.lease.runtimeFence ?? fence
  })
  // No child in this process writes to a journal nobody had open, so whatever it shows running
  // belongs to a generation that is gone, whatever the lease still claims. Settled before any
  // reader or child sees it; an acquisition settles against the generation it takes instead.
  const plan = planOpenSettlement(opened.journal, openSettlementRecordFacts(record), {
    acquisition: options.acquisition,
    settlesRosters: !opened.journal.needsRebuild
  })
  await appendOpenSettlement(opened.journal, plan, fence, (error) =>
    deps.logger.warn("settling a gone agent's work on open failed", {
      scope: 'open-dead-generation',
      sessionId,
      error
    })
  )
  opened.journal.backfillSessionStatus()
  return {
    session: { journal: opened.journal, params, child: null },
    reset: opened.recovery?.reset ?? null
  }
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
  if (!session || !record?.lease.deathEvidence) {
    return
  }
  const { goneGeneration } = planOpenSettlement(
    session.journal,
    openSettlementRecordFacts(record),
    { settlesRosters: false }
  )
  try {
    if (goneGeneration && goneGeneration.mutations.length > 0) {
      await appendGoneGenerationSettlement(
        session.journal,
        goneGeneration,
        record.lease.runtimeFence
      )
    }
  } catch (error) {
    // Best effort: the next open or acquire re-derives it.
    deps.logger.warn("settling a gone agent's work on open failed", {
      scope: 'open-dead-generation',
      sessionId,
      error
    })
  }
}

export function openSettlementRecordFacts(record: AgentSessionRecord): OpenSettlementRecordFacts {
  return {
    sessionId: record.sessionId,
    fence: record.lease.runtimeFence,
    deathEvidence: record.lease.deathEvidence ?? null,
    failureTextContext: structuredAgentSessionFailureWordsContext(record)
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
