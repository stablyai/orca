import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import { readCodexSubagentAnnouncement } from './codex-subagent-activity'
import {
  codexCollabClosedThread,
  readCodexCollabAgentToolCall
} from './codex-collab-agent-tool-call'
import { codexChildTurnState } from './codex-subagent-executions'
import { readRecord } from './codex-item-field-readers'
import { readCodexThreadItem } from './codex-structured-item-translation'
import { readCodexProviderVerdict } from './codex-structured-journal-provider-verdicts'
import { readCodexTurnId } from './codex-structured-thread-facts'

export type CodexBackgroundTaskFrame =
  | {
      kind: 'subagent'
      agentThreadId: string
      label: string | null
      parentTurnId: string | null | undefined
      /** The reporting thread, for a spawn: the agent that spawned the child. */
      spawnerThreadId: string | undefined
    }
  | {
      kind: 'turn'
      threadId: string
      turnId: string
      state: NativeChatSubagentState
    }
  | {
      /** A child turn that ended with no `turn/completed`. No `turnId`: the one it is running.
       *  `threadId` is the child's, which for a `closeAgent` is not the thread that sent it. */
      kind: 'turn-ended'
      threadId: string
      turnId: string | null
      state: CodexChildTurnEnding
    }

type CodexChildTurnEnding = Extract<NativeChatSubagentState, 'failed' | 'stopped' | 'unverifiable'>

export type CodexBackgroundTaskEvent = {
  method: string
  threadId: string
  params: unknown
}

/**
 * The two ways Codex ends a child's turn without `turn/completed`. An `error` it will not retry is
 * that turn's own end: the verdict the transcript settles the same turn on. A closed thread ran
 * its last turn, and Codex never said how it went. A `systemError` status is neither: Codex raises
 * it for errors that leave the turn running too (a refused steer), and a turn one ends also
 * carries the `error`.
 */
function readCodexChildTurnEnding(
  event: CodexBackgroundTaskEvent
): CodexBackgroundTaskFrame | null {
  if (readCodexProviderVerdict(event.method, event.params) === 'turn-failed') {
    const turnId = readCodexTurnId(event.params)
    return { kind: 'turn-ended', threadId: event.threadId, turnId, state: 'failed' }
  }
  return event.method === 'thread/closed'
    ? { kind: 'turn-ended', threadId: event.threadId, turnId: null, state: 'unverifiable' }
    : null
}

export function readCodexBackgroundTaskFrame(
  event: CodexBackgroundTaskEvent,
  primaryThreadId: string
): CodexBackgroundTaskFrame | null {
  // The session's own turn ends through the journal's turn boundaries, never here.
  const ending = event.threadId === primaryThreadId ? null : readCodexChildTurnEnding(event)
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
  if (!item) {
    return null
  }
  const call = readCodexCollabAgentToolCall(item)
  const closed = call && codexCollabClosedThread(call)
  if (closed && closed !== primaryThreadId) {
    // The caller shut the helper down: whatever turn it was running is over, stopped by its caller.
    return { kind: 'turn-ended', threadId: closed, turnId: null, state: 'stopped' }
  }
  const announcement = readCodexSubagentAnnouncement(item)
  if (!announcement || announcement.agentThreadId === primaryThreadId) {
    return null
  }
  return {
    kind: 'subagent',
    agentThreadId: announcement.agentThreadId,
    label: announcement.label,
    parentTurnId: announcement.namesParentTurn ? readCodexTurnId(event.params) : undefined,
    // Only a spawn names the spawner: other announcements ride whichever agent acted.
    spawnerThreadId: announcement.spawned ? event.threadId : undefined
  }
}
