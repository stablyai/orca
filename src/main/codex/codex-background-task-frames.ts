import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import {
  codexSubagentLabel,
  isCodexRootAgentActivity,
  readCodexSubagentActivity
} from './codex-subagent-activity'
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
      /** A child turn that ended with no `turn/completed`. No `turnId`: the one it is running. */
      kind: 'turn-ended'
      threadId: string
      turnId: string | null
      state: CodexChildTurnEnding
    }

type CodexChildTurnEnding = Extract<NativeChatSubagentState, 'failed' | 'unverifiable'>

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
