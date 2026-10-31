import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import { readCodexSubagentAnnouncements } from './codex-subagent-activity'
import { codexChildTurnState, type CodexSubagentExecutions } from './codex-subagent-executions'
import { readRecord } from './codex-item-field-readers'
import { readCodexThreadItem } from './codex-structured-item-translation'
import { readCodexTurnId } from './codex-structured-thread-facts'

export type CodexAnnouncedChild = {
  agentThreadId: string
  label: string | null
  /** Set only by spawn announcements, whose reporting thread is the spawner. */
  spawnerThreadId: string | undefined
}

export type CodexBackgroundTaskFrame =
  | {
      kind: 'subagents'
      children: CodexAnnouncedChild[]
    }
  | {
      kind: 'turn'
      threadId: string
      turnId: string
      state: NativeChatSubagentState
    }
  | {
      /** Thread closure without a final turn outcome. */
      kind: 'thread-closed'
      threadId: string
    }

export type CodexBackgroundTaskEvent = {
  method: string
  threadId: string
  params: unknown
}

// Only thread closure substitutes for turn/completed; errors await that frame's outcome and timing.
function readCodexChildThreadClosed(
  event: CodexBackgroundTaskEvent
): CodexBackgroundTaskFrame | null {
  return event.method === 'thread/closed'
    ? { kind: 'thread-closed', threadId: event.threadId }
    : null
}

export function readCodexBackgroundTaskFrame(
  event: CodexBackgroundTaskEvent,
  primaryThreadId: string
): CodexBackgroundTaskFrame | null {
  // The session's own turn ends through the journal's turn boundaries, never here.
  const ending = event.threadId === primaryThreadId ? null : readCodexChildThreadClosed(event)
  if (ending) {
    return ending
  }
  if (event.method === 'turn/started' || event.method === 'turn/completed') {
    const turnId = readCodexTurnId(event.params)
    if (turnId === null) {
      return null
    }
    return {
      kind: 'turn',
      threadId: event.threadId,
      turnId,
      state:
        event.method === 'turn/started'
          ? 'working'
          : codexChildTurnState(readRecord(readRecord(event.params).turn).status)
    }
  }
  if (event.method !== 'item/started' && event.method !== 'item/completed') {
    return null
  }
  const item = readCodexThreadItem(readRecord(event.params).item)
  const children = (item ? readCodexSubagentAnnouncements(item, primaryThreadId) : []).map(
    (announcement) => ({
      agentThreadId: announcement.agentThreadId,
      label: announcement.label,
      // Only a spawn names the spawner: other announcements ride whichever agent acted.
      spawnerThreadId: announcement.spawned ? event.threadId : undefined
    })
  )
  return children.length > 0 ? { kind: 'subagents', children } : null
}

/** Idempotent: the journal observes before writing rows, then background tasks observe again. */
export function observeCodexExecutionFrame(
  executions: CodexSubagentExecutions,
  frame: CodexBackgroundTaskFrame | null,
  primaryThreadId: string
): void {
  if (frame?.kind === 'subagents') {
    for (const child of frame.children) {
      executions.register(child.agentThreadId, child.label, child.spawnerThreadId)
    }
  } else if (frame?.kind === 'thread-closed') {
    executions.closeThread(frame.threadId)
  } else if (frame && frame.threadId !== primaryThreadId) {
    executions.observeTurn(frame.threadId, frame.turnId, frame.state)
  }
}
