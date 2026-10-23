import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { splitWorktreeId, splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { PtyProcessInfo } from './pty-process-info'

export function worktreePtyOwnership(worktreeId: string): (session: PtyProcessInfo) => boolean {
  const prefix = `${worktreeId}@@`
  const fullWorktreePath = splitWorktreeId(worktreeId)?.worktreePath
  // Folder instances share a checkout; cwd alone cannot identify the owning instance.
  const cwdFallbackPath =
    splitWorktreeIdForFilesystem(worktreeId)?.worktreePath === fullWorktreePath
      ? fullWorktreePath
      : undefined
  return (session) =>
    session.id.startsWith(prefix) ||
    session.worktreeId === worktreeId ||
    (cwdFallbackPath !== undefined &&
      session.worktreeId === undefined &&
      typeof session.cwd === 'string' &&
      session.cwd.length > 0 &&
      isPathInsideOrEqual(cwdFallbackPath, session.cwd))
}
