import { setBoundedMapEntry } from './runtime/runtime-async-boundaries'

export const WORKTREE_CREATE_BURST_MS = 5 * 60_000
const WORKTREE_CREATE_PREPARATION_CONSUME_MAX = 64

const lastConsumedAt = new Map<string, number>()

/** Only repeated creates justify keeping a full replacement checkout on disk until its TTL. */
export function recordPreparationConsume(key: string, now = Date.now()): boolean {
  const previous = lastConsumedAt.get(key)
  setBoundedMapEntry(lastConsumedAt, key, now, WORKTREE_CREATE_PREPARATION_CONSUME_MAX)
  return previous !== undefined && now - previous <= WORKTREE_CREATE_BURST_MS
}

export function resetPreparationConsumeHistoryForTests(): void {
  lastConsumedAt.clear()
}
