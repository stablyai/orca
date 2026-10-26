import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
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
  queuedCommands: false,
  queuedMessageEdit: true,
  statusFeed: false,
  quietRepeatedStop: false,
  sendOptions: false,
  conversationStop: false,
  permissionModes: false,
  itemDetail: false,
  phoneAttachments: false
}
export const LEGACY: StructuredAgentSessionHostSupport = {
  ...CAPABLE,
  queuedMessages: false,
  queuedMessageEdit: false
}

export function ok(result: unknown): RpcResponse {
  return { id: 'request-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

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
  items?: AgentJournalRenderItem[]
  fence?: number
  runningTurn?: boolean
  submissions?: AgentJournalSubmission[]
}): Extract<AgentSessionSubscribeEvent, { type: 'snapshot' }> {
  const items: AgentJournalRenderItem[] =
    input?.items ??
    (input?.runningTurn
      ? [
          {
            itemId: 'turn-item-1',
            revision: 1,
            body: { kind: 'turn', turnId: 'turn-1', state: 'running' },
            sequence: 1,
            observedAt: 1
          }
        ]
      : [])
  const oldest = items[0]
  const newest = items.at(-1)
  const fence = input?.fence ?? 3
  return {
    type: 'snapshot',
    sessionId: SESSION_ID,
    fence,
    page: {
      sessionId: SESSION_ID,
      epoch: 'epoch-1',
      fence,
      direction: 'tail',
      items,
      removedItemIds: [],
      submissions: input?.submissions ?? [],
      window: {
        oldest: oldest ? { epoch: 'epoch-1', sequence: oldest.sequence } : null,
        newest: newest ? { epoch: 'epoch-1', sequence: newest.sequence } : null,
        nextCursor: { epoch: 'epoch-1', sequence: oldest?.sequence ?? 0 }
      },
      liveCursor: { epoch: 'epoch-1', sequence: newest?.sequence ?? 0 },
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
