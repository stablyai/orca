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
    }
  | {
      kind: 'turn'
      threadId: string
      turnId: string
      state: NativeChatSubagentState
    }

export type CodexBackgroundTaskEvent = {
  method: string
  threadId: string
  params: unknown
}

export function readCodexBackgroundTaskFrame(
  event: CodexBackgroundTaskEvent,
  primaryThreadId: string
): CodexBackgroundTaskFrame | null {
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
        : undefined
  }
}
