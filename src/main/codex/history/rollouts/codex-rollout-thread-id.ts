// A reverted thread's rollout adds `_<rollout id>` after the thread id.
const CODEX_ROLLOUT_THREAD_ID_PATTERN =
  /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]{36})?\.jsonl(?:\.zst)?$/i

export function parseCodexRolloutThreadId(
  filePath: string
): { threadId: string; rolloutStamp: string } | null {
  const match = CODEX_ROLLOUT_THREAD_ID_PATTERN.exec(lastPathSegment(filePath))
  return match ? { threadId: match[2].toLowerCase(), rolloutStamp: match[1] } : null
}

function lastPathSegment(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? ''
}
