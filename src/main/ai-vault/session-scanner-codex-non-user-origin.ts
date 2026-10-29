import { asRecord, extractString } from './session-scanner-values'

/** Join by parentThreadId; agentPath is a label, and fork lineage does not establish spawn parentage. */
export type CodexSubagentParentage = {
  parentThreadId: string | null
  /** Direct children have depth 1. */
  depth: number | null
  agentNickname: string | null
  agentRole: string | null
  agentPath: string | null
}

/** Non-user classification is independent of readable parentage; null parentage does not imply a root thread. */
export type CodexNonUserOrigin = {
  /** The `source` outer tag: 'subagent' or 'internal'. Null when only `thread_source` stated it. */
  source: string | null
  /** Verbatim inner union tag, including kinds introduced by future releases. */
  kind: string | null
  /** Free-text payload of the inner tag, such as an other label. */
  kindLabel: string | null
  /** Verbatim non-user `thread_source`; null on payloads that state none. */
  threadSource: string | null
  parentage: CodexSubagentParentage | null
}

const NON_USER_SOURCE_TAGS = new Set(['subagent', 'internal'])
// Other thread_source values are client feature labels (e.g. Codex Desktop `automation`) on top-level threads.
const NON_USER_THREAD_SOURCES = new Set(['subagent', 'guardian_review', 'memory_consolidation'])

/** Either structural source or thread_source can classify a thread; provider versions may omit either field. */
export function readCodexNonUserOrigin(
  payload: Record<string, unknown>
): CodexNonUserOrigin | null {
  const threadSource = extractString(payload.thread_source) ?? extractString(payload.threadSource)
  const outerTag = readCodexUnionTag(payload.source)
  const nonUserSource = outerTag && NON_USER_SOURCE_TAGS.has(outerTag.kind) ? outerTag : null
  const normalizedThreadSource = threadSource?.toLowerCase()
  // Explicit thread_source outranks structural source when they disagree.
  if (normalizedThreadSource === 'user') {
    return null
  }
  if (!nonUserSource && !NON_USER_THREAD_SOURCES.has(normalizedThreadSource ?? '')) {
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

/** Accept bare-string or single-key union tags; ambiguous values must not hide user threads. */
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

// Spawn fields may be copied onto the payload; depth has no copy, and agent_type aliases agent_role.
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

function codexSpawnDepth(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}
