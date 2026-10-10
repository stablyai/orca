// Reading Codex's subagent wire shapes.
//
// Established by a live probe against `codex app-server` 0.152.1, not inferred:
//   * `subAgentActivity` items carry `{kind, agentThreadId, agentPath}`, and each
//     one arrives TWICE — via `item/started` and again via `item/completed`.
//   * `agentPath` is a tree path (`/root`, `/root/list_directory`); the trailing
//     segment is a semantic task name and the only label available. There is no
//     `thread/started` for a child, so nickname/role/depth do not exist.
//   * Codex's DEFAULT multi-agent mode sends no `subAgentActivity` at all; a
//     helper appears only in the `collabAgentToolCall` items that spawn, message,
//     wait on or close it (read in `codex-collab-agent-tool-call.ts`). Either item
//     announces the same child, keyed by its thread id, and child turn events own
//     its execution state.
//   * `thread/tokenUsage/updated` reports a per-thread RUNNING TOTAL, so the
//     latest frame replaces the previous one — it is never accumulated.

import {
  codexCollabHelperLabel,
  readCodexCollabAgentToolCall
} from './codex-collab-agent-tool-call'
import type { CodexThreadItem } from './codex-thread-item-identity'

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

/** A child the item says exists, from either wire shape Codex announces one with. */
export type CodexSubagentAnnouncement = {
  agentThreadId: string
  label: string | null
  /** The item's turn is the one the child was spawned or messaged from. */
  namesParentTurn: boolean
  /** The item is the spawn itself, so the thread that carried it spawned the child. */
  spawned: boolean
}

/** Collab calls that hand a helper work from the caller's turn, as an `interacted` activity does. */
const CODEX_COLLAB_TOOLS_THAT_TASK_A_HELPER: ReadonlySet<string> = new Set([
  'spawnAgent',
  'sendInput'
])

/** The children an item announces: a `subAgentActivity`'s, or every helper a collab call names,
 *  keyed by thread id so repeats announce one child. Neither the tree root nor the session's own
 *  thread is a child. Any call counts, since a helper whose spawn was never seen (compacted out of
 *  history) is known only from the calls on it. A spawn counts whatever its status: Codex reports
 *  `failed` for a helper that errored at birth, yet names the thread it created, and that thread
 *  can still run. */
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
            namesParentTurn: activity.kind === 'started' || activity.kind === 'interacted',
            spawned: activity.kind === 'started'
          }
        ]
  }
  const call = readCodexCollabAgentToolCall(item)
  if (!call) {
    return []
  }
  const spawned = call.tool === 'spawnAgent'
  // Only a spawn's prompt describes its helper; another call's prompt is a later message to it,
  // so a helper no spawn named reads as any unnamed subagent does.
  const label = spawned ? codexCollabHelperLabel(call.prompt) : null
  const namesParentTurn = CODEX_COLLAB_TOOLS_THAT_TASK_A_HELPER.has(call.tool)
  return call.helperThreadIds.map((agentThreadId) => ({
    agentThreadId,
    label,
    namesParentTurn,
    spawned
  }))
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

/** Pull the `subAgentActivity` item out of a raw notification payload.
 *
 *  Lives beside the readers rather than in the translator: the translator's job
 *  is routing, and this is the shape check that decides whether a frame is one
 *  of ours at all. Returns null for anything that is not a thread item, which is
 *  the translator's signal to keep looking. */
export function readCodexNotificationThreadItem(
  params: unknown,
  read: (value: unknown) => CodexThreadItem | null
): CodexThreadItem | null {
  const record =
    typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
  return read(record.item)
}
