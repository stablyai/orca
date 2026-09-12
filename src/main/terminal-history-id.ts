import { createHash } from 'node:crypto'

/** First 16 hex chars of SHA-256 of the worktreeId. */
export function hashWorktreeId(worktreeId: string): string {
  return createHash('sha256').update(worktreeId).digest('hex').slice(0, 16)
}
