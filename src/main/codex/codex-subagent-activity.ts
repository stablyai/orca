// Reading Codex's subagent wire shapes.
//
// Established by a live probe against `codex app-server` 0.152.1, not inferred:
//   * `subAgentActivity` items carry `{kind, agentThreadId, agentPath}`, and each
//     one arrives TWICE — via `item/started` and again via `item/completed`.
//   * `agentPath` is a tree path (`/root`, `/root/list_directory`); the trailing
//     segment is a semantic task name and the only label available. There is no
//     `thread/started` for a child, so nickname/role/depth do not exist.
//   * `agentsStates` on `collabAgentToolCall` arrived empty (`{}`) throughout the
//     probe, so nothing here reads it — state comes from `kind` alone.
//   * `thread/tokenUsage/updated` reports a per-thread RUNNING TOTAL, so the
//     latest frame replaces the previous one — it is never accumulated.

import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import type { CodexThreadItem } from './codex-structured-item-translation'

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

/**
 * The state a `kind` implies for the child it names.
 *
 * An unrecognized kind means "this child exists and reported something we
 * cannot classify" — `working`, which the turn-end sweep will later settle to
 * `unverifiable`. Claiming a terminal state from an unknown kind would assert
 * an outcome the wire never gave us.
 */
export function codexSubagentStateForKind(kind: string): NativeChatSubagentState {
  if (kind === 'completed') {
    return 'completed'
  }
  if (kind === 'interrupted') {
    return 'stopped'
  }
  return 'working'
}

/** Path segments, empty ones dropped: `/root/list_directory` → 2 segments. */
export function codexSubagentPathSegments(agentPath: string | null): string[] {
  return agentPath === null ? [] : agentPath.split('/').filter((part) => part.length > 0)
}

/** The one path segment that names the parent turn itself rather than a child.
 *  Compared after the same normalization the label uses, not against the raw
 *  string: `/root/` and `/root//` are the same node as `/root`, and a check that
 *  disagreed with `codexSubagentPathSegments` would let one path be both the
 *  turn and a child of it — a phantom row labelled `root` inflating the group.
 *  Only this segment is the root; `/morpheus` is single-segment too but IS a
 *  child. */
const CODEX_ROOT_AGENT_SEGMENT = 'root'

/**
 * Whether an activity item describes the ROOT of the agent tree rather than a
 * spawned child. Counting the root would make the parent turn report itself as
 * its own subagent.
 *
 * A path-less item cannot be placed in the tree at all, so it is treated as a
 * child: dropping it would lose a real spawn, while an extra row is visible and
 * self-correcting.
 */
export function isCodexRootAgentActivity(activity: CodexSubagentActivity): boolean {
  const segments = codexSubagentPathSegments(activity.agentPath)
  return segments.length === 1 && segments[0] === CODEX_ROOT_AGENT_SEGMENT
}

/** Row label: the agent path's trailing segment, trimmed. A segment with nothing
 *  visible in it survives the empty-segment filter but would draw a nameless row,
 *  so it reads as no label and the caller's placeholder takes over. Trimmed
 *  because the caller keys its collision ordinals on this string: ` read ` and
 *  `read` render identically and must therefore collide. */
export function codexSubagentLabel(activity: CodexSubagentActivity): string | null {
  const trailing = codexSubagentPathSegments(activity.agentPath).at(-1)?.trim()
  return trailing !== undefined && trailing.length > 0 ? trailing : null
}

export type CodexThreadTokenTotal = { threadId: string; totalTokens: number }

/** `{threadId, tokenUsage: {total: {totalTokens}}}`. Older builds put the total
 *  on the envelope, so both shapes are accepted. */
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
