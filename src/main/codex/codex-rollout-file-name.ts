// Codex's own grammar: rollout-<YYYY-MM-DDTHH-MM-SS>-<threadId>[_<rolloutId>].jsonl[.zst].
// A `_<rolloutId>` file is a later segment of the same conversation (thread/revert).
// The stamp is matched loosely, as Orca always has; Codex itself writes 19 characters.
const ROLLOUT_FILE_NAME_PATTERN =
  /^rollout-(?:(.+)-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\.jsonl(?:\.zst)?$/i

export type CodexRolloutFileName = {
  timestamp: string
  threadId: string
  rolloutId: string
}

export function parseCodexRolloutFileName(fileName: string): CodexRolloutFileName | null {
  const match = ROLLOUT_FILE_NAME_PATTERN.exec(fileName)
  if (!match) {
    return null
  }
  const threadId = match[2].toLowerCase()
  return { timestamp: match[1] ?? '', threadId, rolloutId: match[3]?.toLowerCase() ?? threadId }
}

/** Positive when `left` is the newer segment, by Codex's filename rule (timestamp, then UUIDv7). */
export function compareCodexRolloutRecency(
  left: CodexRolloutFileName,
  right: CodexRolloutFileName
): number {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp < right.timestamp ? -1 : 1
  }
  return left.rolloutId === right.rolloutId ? 0 : left.rolloutId < right.rolloutId ? -1 : 1
}

export function codexRolloutFileNameOf(filePath: string): CodexRolloutFileName | null {
  return parseCodexRolloutFileName(filePath.split(/[\\/]/).at(-1) ?? '')
}
