// The one way a conversation's journal becomes open on this host: for a send, for a reader, and
// for an attach that finds none open.
//
// It opens with recovery, so an unusable journal is rebuilt rather than refused, and it marks what
// an earlier host process handed over and left unanswered as in doubt — the crash boundary. That
// needs no lease: provider history decides such a row later, under a won lease, in the attach. A
// row an earlier process accepted and never handed over is the delivery loop's, which the open
// wakes. Nothing here starts a provider child.

import type { AgentJournalResetReason } from '../../../shared/agent-session-journal-types'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
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
  journalRoot: string
  onEventSinkError?: StructuredAgentSessionHostDeps['onEventSinkError']
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
  sessionId: string
): Promise<StructuredAgentSessionHostSession | null> {
  const open = context.sessions.get(sessionId)
  if (open) {
    return open
  }
  const record = context.deps.store.getRecord(sessionId)
  if (!record) {
    return null
  }
  const opened = await openStructuredAgentSessionConversationJournal(context.deps, record)
  await context.adoptOpened(sessionId, opened)
  return opened.session
}

/** The open itself, indexed by nobody yet: the caller adopts the result. */
export async function openStructuredAgentSessionConversationJournal(
  deps: Omit<StructuredAgentSessionConversationOpenDeps, 'store'>,
  record: AgentSessionRecord
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
    journalDir: journalDirectoryFor(deps.journalRoot, {
      workspaceId: record.location.workspaceId,
      sessionId
    }),
    fence,
    historyFilePath: (await deps.adapter.historyFilePath?.({ identity })) ?? null
  })
  try {
    // A queued row found here is a leftover the delivery loop's first step rejects; a handed-over
    // one is only doubt, which provider history decides under a won lease.
    await opened.journal.markPendingSubmissionsUnknown(fence)
  } catch (error) {
    deps.onEventSinkError?.({ sessionId, error })
  }
  return {
    session: { journal: opened.journal, params, child: null },
    reset: opened.recovery?.reset ?? null
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
