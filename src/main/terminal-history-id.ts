import { createHash } from 'node:crypto'

export function hashWorktreeId(worktreeId: string): string {
  return createHash('sha256').update(worktreeId).digest('hex').slice(0, 16)
}
