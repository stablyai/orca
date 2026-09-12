import type {
  AgentJournalRenderItem,
  AgentJournalResolution
} from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'

type SnapshotEvent = Extract<AgentSessionSubscribeEvent, { type: 'snapshot' }>

export function snapshotEvent(fence = 3): SnapshotEvent {
  return {
    type: 'snapshot',
    sessionId: 'session-1',
    fence,
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      fence,
      direction: 'tail',
      items: [],
      removedItemIds: [],
      submissions: [],
      window: {
        oldest: null,
        newest: null,
        nextCursor: { epoch: 'epoch-1', sequence: 0 }
      },
      liveCursor: { epoch: 'epoch-1', sequence: 0 },
      hasOlder: false,
      hasNewer: false
    }
  }
}

export function snapshotWithMessage(): SnapshotEvent {
  const event = snapshotEvent()
  return {
    ...event,
    page: {
      ...event.page,
      items: [
        {
          itemId: 'msg-1',
          revision: 1,
          sequence: 1,
          observedAt: 10,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'sent before the blip' }]
          }
        }
      ],
      window: {
        oldest: { epoch: 'epoch-1', sequence: 1 },
        newest: { epoch: 'epoch-1', sequence: 1 },
        nextCursor: { epoch: 'epoch-1', sequence: 2 }
      },
      liveCursor: { epoch: 'epoch-1', sequence: 1 }
    }
  }
}

function pendingResolution(): AgentJournalResolution {
  return {
    state: 'pending',
    selectedOptionId: null,
    resolvedBy: null,
    resolvedAt: null
  }
}

export function approvalItem(): AgentJournalRenderItem {
  return {
    itemId: 'approval-1',
    revision: 2,
    sequence: 1,
    observedAt: 10,
    body: {
      kind: 'approval',
      title: 'Allow Bash?',
      detail: 'rm -rf build',
      options: [
        { id: 'allow-once', label: 'Allow once' },
        { id: 'deny', label: 'Deny' }
      ],
      resolution: pendingResolution()
    }
  }
}

export function approvalItemWithIdentity(itemId: string, revision: number): AgentJournalRenderItem {
  return { ...approvalItem(), itemId, revision }
}

export function questionItem(): AgentJournalRenderItem {
  return {
    itemId: 'question-1',
    revision: 7,
    sequence: 2,
    observedAt: 12,
    body: {
      kind: 'question',
      question: 'Pick destination',
      freeTextQuestionId: 'free-q',
      options: [
        { id: 'choice-a', label: 'Choice A' },
        { id: 'choice-b', label: 'Choice B' }
      ],
      resolution: pendingResolution()
    }
  }
}

export function questionItemWithIdentity(itemId: string, revision: number): AgentJournalRenderItem {
  return { ...questionItem(), itemId, revision }
}

export function runningStatusItem(): AgentJournalRenderItem {
  return {
    itemId: 'status-1',
    revision: 1,
    sequence: 3,
    observedAt: 14,
    body: {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId: 'turn-1', state: 'running' }
    }
  }
}
