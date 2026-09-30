import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import {
  codexSubagentLabel,
  isCodexRootAgentActivity,
  readCodexSubagentActivity
} from './codex-subagent-activity'
import { codexChildTurnState } from './codex-subagent-executions'
import { readRecord } from './codex-item-field-readers'
import { readCodexThreadItem } from './codex-structured-item-translation'
import { readCodexTurnId } from './codex-structured-thread-facts'

export type CodexBackgroundTaskFrame =
  | {
      kind: 'subagent'
      agentThreadId: string
      label: string | null
      parentTurnId: string | null | undefined
      /** The reporting thread, for a `started` activity: the agent that spawned the child. */
      spawnerThreadId: string | undefined
    }
  | {
      kind: 'turn'
      threadId: string
      turnId: string
      state: NativeChatSubagentState
    }
  | {
      /** A child thread that closed: it ran its last turn, and Codex never said how it went. */
      kind: 'thread-closed'
      threadId: string
    }

export type CodexBackgroundTaskEvent = {
  method: string
  threadId: string
  params: unknown
}

/**
 * The one way Codex ends a child's turn without `turn/completed`: a closed thread ran its last
 * turn and Codex never said how it went. A turn-ending `error` is not one — Codex follows it with
 * a failed `turn/completed` for the same turn, which is that turn's end and carries the duration
 * and receipt time the error does not.
 */
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
  const activity = item && readCodexSubagentActivity(item)
  if (
    !activity ||
    activity.agentThreadId === primaryThreadId ||
    isCodexRootAgentActivity(activity)
  ) {
    return null
  }
  return {
    kind: 'subagent',
    agentThreadId: activity.agentThreadId,
    label: codexSubagentLabel(activity),
    parentTurnId:
      activity.kind === 'started' || activity.kind === 'interacted'
        ? readCodexTurnId(event.params)
        : undefined,
    // Only `started` names the spawner: other kinds ride whichever agent acted.
    spawnerThreadId: activity.kind === 'started' ? event.threadId : undefined
  }
}
