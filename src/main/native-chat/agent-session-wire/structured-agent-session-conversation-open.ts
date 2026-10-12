// The one way a conversation's journal becomes open on this host: for a send, for a reader, and
// for an attach that finds none open.
//
// It only reads. A damaged journal fails the open, which refuses it as unloadable. What an earlier
// generation or host process left running or queued is settled by the ownership event that ended
// it — its exit, the next acquisition, or startup (`structured-agent-session-leftover-settlement.ts`,
// `structured-agent-session-startup-settlement.ts`) — never here. Nothing here starts a provider
// child.

import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  attachFingerprintFields,
  journalIdentityFor,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
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
  deps: Omit<StructuredAgentSessionConversationOpenDeps, 'store' | 'logger'>,
  record: AgentSessionRecord
): Promise<OpenedStructuredAgentSessionConversation> {
  const { sessionId } = record
  const params = attachParamsForRecord(record, {
    clientOperationId: `read-restore:${sessionId}`,
    expectedRuntimeFence: record.lease.runtimeFence
  })
  const identity = journalIdentityFor(record, params)
  const journal = await openAgentSessionJournal({ identity, database: deps.journalDatabase })
  journal.holdReopenFromOpen()
  return { session: { journal, params, child: null } }
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
