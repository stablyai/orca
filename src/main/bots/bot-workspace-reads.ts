import {
  createScopedWorktreeReads,
  type ScopedWorktreeReads
} from '../runtime/workspaces/catalog/scoped-worktree-row-resolution'

/** One batch's repo reads and path checks, shared by every workspace it reads. */
export type BotWorkspaceReads = {
  worktrees: ScopedWorktreeReads
  exists: Map<string, boolean>
}

export function createBotWorkspaceReads(): BotWorkspaceReads {
  return { worktrees: createScopedWorktreeReads(), exists: new Map() }
}

/** `check`'s answer for this path, asked once per batch; without a batch, asked every time. */
export function existsOnce(
  pathValue: string,
  check: (pathValue: string) => boolean,
  reads: BotWorkspaceReads | undefined
): boolean {
  let known = reads?.exists.get(pathValue)
  if (known === undefined) {
    known = check(pathValue)
    reads?.exists.set(pathValue, known)
  }
  return known
}
