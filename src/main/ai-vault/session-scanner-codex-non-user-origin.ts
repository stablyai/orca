import { asRecord, extractString } from './session-scanner-values'

/**
 * What Codex stated about the spawn that produced a thread. `parentThreadId` is
 * the only join key here: `agentPath` is a slash-rooted naming path
 * (`/root/pr_review_pass_1`) that labels agents rather than identifying them.
 * Fork lineage is a separate key and deliberately not read into this — a thread
 * the user forked is still their own.
 */
export type CodexSubagentParentage = {
  parentThreadId: string | null
  /** 1 for a direct child of a user thread; real rollouts nest to 3. */
  depth: number | null
  agentNickname: string | null
  agentRole: string | null
  agentPath: string | null
}

/**
 * Why a Codex rollout is not the user's own thread, and who spawned it. Those
 * are two facts and Codex keeps them apart, so this does too.
 *
 * `source` is a nested union: its outer tag says an agent Codex spawned
 * (`subagent`) or machinery it ran for itself (`internal`), and the inner `kind`
 * says which — a spawn record, a review pass, a compaction, a guardian. Only the
 * spawn kind carries a spawn record, so a null `parentage` means nothing about a
 * spawn was readable, never that the thread is rooted. Every other outer tag
 * (`cli`, `vscode`, `exec`, `mcp`, `custom`, `unknown`) is a thread the user
 * started and produces no origin at all.
 */
export type CodexNonUserOrigin = {
  /** The `source` outer tag: 'subagent' or 'internal'. Null when only `thread_source` stated it. */
  source: string | null
  /**
   * The inner tag, verbatim snake_case: 'thread_spawn', 'review', 'compact',
   * 'memory_consolidation', 'other', 'guardian', or one a later release adds.
   */
  kind: string | null
  /** Free text the inner tag carries — the 'other' tag's label; null for tags without one. */
  kindLabel: string | null
  /** Verbatim non-user `thread_source`; null on payloads that state none. */
  threadSource: string | null
  parentage: CodexSubagentParentage | null
}

// The two `source` tags that are not the user's own thread. Codex's runtime
// draws the same line: everything else, spawn records included, gets the
// treatment a real agent session gets.
const NON_USER_SOURCE_TAGS = new Set(['subagent', 'internal'])

/**
 * Read a `session_meta` payload's non-user origin, or null for a user thread.
 *
 * The payload states this in two places that disagree in coverage. `source` is
 * the structural field Codex's own runtime switches on; `thread_source` is an
 * analytics label that some releases omit entirely. A payload stating only one
 * of them is normal, so each is read independently and a tag carrying no spawn
 * record still classifies the thread.
 */
export function readCodexNonUserOrigin(
  payload: Record<string, unknown>
): CodexNonUserOrigin | null {
  const threadSource = extractString(payload.thread_source) ?? extractString(payload.threadSource)
  const outerTag = readCodexUnionTag(payload.source)
  const nonUserSource = outerTag && NON_USER_SOURCE_TAGS.has(outerTag.kind) ? outerTag : null
  if (threadSource) {
    // A stated thread_source is the provider's own verdict, so it outranks
    // `source` even when the two disagree.
    if (threadSource.toLowerCase() === 'user') {
      return null
    }
  } else if (!nonUserSource) {
    return null
  }
  const innerTag = readCodexUnionTag(nonUserSource?.content)
  return {
    source: nonUserSource?.kind ?? null,
    kind: innerTag?.kind ?? null,
    kindLabel: extractString(innerTag?.content),
    threadSource,
    parentage: readCodexSubagentParentage(payload, asRecord(innerTag?.content))
  }
}

type CodexUnionTag = {
  kind: string
  /** The tag's payload: free text, a nested tag, or the spawn record. */
  content: unknown
}

/**
 * Read one externally tagged union value: a payload-less tag is a bare string
 * (`'cli'`, `'review'`), a tag with one is a single-key object
 * (`{ subagent: ... }`, `{ thread_spawn: { ... } }`, `{ other: 'label' }`).
 * Anything else states no tag — and treating an unreadable value as a spawn
 * would drop the user's own thread out of their history, where letting an
 * unrecognised one through only shows a transcript they can see and ignore.
 */
function readCodexUnionTag(value: unknown): CodexUnionTag | null {
  const bareTag = extractString(value)
  if (bareTag) {
    return { kind: bareTag, content: undefined }
  }
  const record = asRecord(value)
  const keys = record ? Object.keys(record) : []
  const kind = keys.length === 1 ? extractString(keys[0]) : null
  return kind && record ? { kind, content: record[kind] } : null
}

// The spawn record's fields are copied onto the payload's own keys, so each one
// falls back rather than being discarded with its record. `depth` has no copy to
// fall back to; `agent_role` is documented with `agent_type` as its alias, in
// both places.
function readCodexSubagentParentage(
  payload: Record<string, unknown>,
  spawn: Record<string, unknown> | null
): CodexSubagentParentage | null {
  const parentage: CodexSubagentParentage = {
    parentThreadId:
      extractString(spawn?.parent_thread_id) ?? extractString(payload.parent_thread_id),
    depth: codexSpawnDepth(spawn?.depth),
    agentNickname: extractString(spawn?.agent_nickname) ?? extractString(payload.agent_nickname),
    agentRole:
      extractString(spawn?.agent_role) ??
      extractString(spawn?.agent_type) ??
      extractString(payload.agent_role) ??
      extractString(payload.agent_type),
    agentPath: extractString(spawn?.agent_path) ?? extractString(payload.agent_path)
  }
  return Object.values(parentage).some((field) => field !== null) ? parentage : null
}

// Codex numbers a direct child 1, so a fractional or non-positive depth is
// contradictory data: unknown beats recording it.
function codexSpawnDepth(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}
