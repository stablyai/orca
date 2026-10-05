// The published shapes the queued-message hook tests feed the mobile session: host answers,
// drafts, submissions and stream frames.

import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import type { RpcResponse } from '../transport/types'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'

export const SESSION_ID = 'session-1'

export const CAPABLE: StructuredAgentSessionHostSupport = {
  promptCancel: false,
  questionAnswers: false,
  queuedMessages: true,
  quietRepeatedStop: false
}
export const LEGACY: StructuredAgentSessionHostSupport = { ...CAPABLE, queuedMessages: false }

export function ok(result: unknown): RpcResponse {
  return { id: 'request-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

/** The fields one recorded request carried, read without asserting their shape. */
export function fieldsOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {}
}

export function mutationOk(value: unknown) {
  return ok({
    ok: true,
    replayed: false,
    fence: 3,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value
  })
}

/** A settled submission; `queuedMessageId` marks it as that draft's hand-off. */
export function acceptedSubmission(
  clientMessageId: string,
  queuedMessageId?: string
): AgentJournalSubmission {
  return {
    clientMessageId,
    ...(queuedMessageId ? { queuedMessageId } : {}),
    fence: 3,
    payloadFingerprint: 'fp',
    dispatchState: 'accepted',
    providerItemId: `item-${clientMessageId}`,
    reason: null,
    submittedAt: 10,
    resolvedAt: 11
  }
}

export function queuedDraft(
  overrides: Partial<AgentSessionQueuedMessage> & { messageId: string }
): AgentSessionQueuedMessage {
  return {
    position: 1,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: `text of ${overrides.messageId}` }]
    },
    state: 'waiting',
    ...overrides
  }
}

export function snapshotEvent(input?: {
  queuedMessages?: AgentSessionQueuedMessage[] | null
  runningTurn?: boolean
  submissions?: AgentJournalSubmission[]
}): AgentSessionSubscribeEvent {
  return {
    type: 'snapshot',
    sessionId: SESSION_ID,
    fence: 3,
    page: {
      sessionId: SESSION_ID,
      epoch: 'epoch-1',
      fence: 3,
      direction: 'tail',
      items: input?.runningTurn
        ? [
            {
              itemId: 'turn-item-1',
              revision: 1,
              body: { kind: 'turn', turnId: 'turn-1', state: 'running' },
              sequence: 1,
              observedAt: 1
            }
          ]
        : [],
      removedItemIds: [],
      submissions: input?.submissions ?? [],
      window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-1', sequence: 0 } },
      liveCursor: { epoch: 'epoch-1', sequence: 0 },
      hasOlder: false,
      hasNewer: false
    },
    ...(input?.queuedMessages !== undefined ? { queuedMessages: input.queuedMessages } : {})
  }
}

export function batchEvent(
  queuedMessages?: AgentSessionQueuedMessage[] | null,
  submissions: AgentJournalSubmission[] = [],
  queuePause?: AgentSessionQueuePause | null
): AgentSessionSubscribeEvent {
  return {
    type: 'batch',
    sessionId: SESSION_ID,
    batch: {
      cursor: { epoch: 'epoch-1', sequence: 2 },
      items: [],
      removedItemIds: [],
      submissions
    },
    ...(queuedMessages !== undefined ? { queuedMessages } : {}),
    ...(queuePause !== undefined ? { queuePause } : {})
  }
}
