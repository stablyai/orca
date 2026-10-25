// Wire shapes verified with app-server 0.152.1; default mode may announce helpers only through collab calls.

import {
  codexCollabHelperLabel,
  readCodexCollabAgentToolCall
} from './codex-collab-agent-tool-call'
import type { CodexThreadItem } from './codex-thread-item-identity'
import { codexSubagentPathLabel, codexSubagentPathSegments } from '../../shared/codex-agent-path'

export { codexSubagentPathSegments } from '../../shared/codex-agent-path'

export const CODEX_SUBAGENT_ITEM_TYPE = 'subAgentActivity'
export const CODEX_TOKEN_USAGE_METHOD = 'thread/tokenUsage/updated'

export type CodexSubagentActivity = {
  kind: string
  agentThreadId: string
  agentPath: string | null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function readCodexSubagentActivity(item: CodexThreadItem): CodexSubagentActivity | null {
  if (item.type !== CODEX_SUBAGENT_ITEM_TYPE) {
    return null
  }
  const agentThreadId = nonEmptyString(item.agentThreadId)
  if (!agentThreadId) {
    return null
  }
  return {
    kind: nonEmptyString(item.kind) ?? '',
    agentThreadId,
    agentPath: nonEmptyString(item.agentPath)
  }
}

const CODEX_ROOT_AGENT_SEGMENT = 'root'

/** Normalize root paths like labels; missing paths remain children to avoid losing a real spawn. */
export function isCodexRootAgentActivity(activity: CodexSubagentActivity): boolean {
  const segments = codexSubagentPathSegments(activity.agentPath)
  return segments.length === 1 && segments[0] === CODEX_ROOT_AGENT_SEGMENT
}

/** Trim before collision numbering so visually identical labels share an ordinal group. */
export function codexSubagentLabel(activity: CodexSubagentActivity): string | null {
  return codexSubagentPathLabel(activity.agentPath)
}

export type CodexSubagentAnnouncement = {
  agentThreadId: string
  label: string | null
  /** Only spawn items establish the carrying thread as the parent. */
  spawned: boolean
}

/** Collab references recover compacted-out spawns; even failed spawns can name a runnable child. */
export function readCodexSubagentAnnouncements(
  item: CodexThreadItem,
  primaryThreadId: string | null
): CodexSubagentAnnouncement[] {
  return readAnnouncements(item).filter(({ agentThreadId }) => agentThreadId !== primaryThreadId)
}

function readAnnouncements(item: CodexThreadItem): CodexSubagentAnnouncement[] {
  const activity = readCodexSubagentActivity(item)
  if (activity) {
    return isCodexRootAgentActivity(activity)
      ? []
      : [
          {
            agentThreadId: activity.agentThreadId,
            label: codexSubagentLabel(activity),
            spawned: activity.kind === 'started'
          }
        ]
  }
  const call = readCodexCollabAgentToolCall(item)
  if (!call) {
    return []
  }
  const spawned = call.tool === 'spawnAgent'
  // Follow-up prompts are messages, not the child's task label.
  const label = spawned ? codexCollabHelperLabel(call.prompt) : null
  return call.helperThreadIds.map((agentThreadId) => ({ agentThreadId, label, spawned }))
}

export type CodexThreadTokenTotal = { threadId: string; totalTokens: number }

/** Totals are cumulative per thread; accept nested and legacy envelope fields. */
export function readCodexThreadTokenTotal(params: unknown): CodexThreadTokenTotal | null {
  const root = record(params)
  if (!root) {
    return null
  }
  const threadId = nonEmptyString(root.threadId) ?? nonEmptyString(record(root.thread)?.id)
  if (!threadId) {
    return null
  }
  const usage = record(root.tokenUsage)
  const total = record(usage?.total)?.totalTokens ?? usage?.totalTokens ?? root.totalTokens
  return typeof total === 'number' && Number.isFinite(total) && total >= 0
    ? { threadId, totalTokens: total }
    : null
}

export function readCodexNotificationThreadItem(
  params: unknown,
  read: (value: unknown) => CodexThreadItem | null
): CodexThreadItem | null {
  const record =
    typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
  return read(record.item)
}
