import { isPathInsideOrEqual } from '../../../shared/file-access/cross-platform-path'
import { splitWorktreeId, splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import type { PtyProcessInfo } from './process-info'
import { parsePtySessionId } from '../../../shared/terminal/pty/lifecycle/pty-session-id-format'

export function worktreePtyOwnership(worktreeId: string): (session: PtyProcessInfo) => boolean {
  const fullWorktreePath = splitWorktreeId(worktreeId)?.worktreePath
  // Folder instances share a checkout; cwd alone cannot identify the owning instance.
  const cwdFallbackPath =
    splitWorktreeIdForFilesystem(worktreeId)?.worktreePath === fullWorktreePath
      ? fullWorktreePath
      : undefined
  return (session) =>
    parsePtySessionId(session.id).worktreeId === worktreeId ||
    session.worktreeId === worktreeId ||
    (cwdFallbackPath !== undefined &&
      session.worktreeId === undefined &&
      typeof session.cwd === 'string' &&
      session.cwd.length > 0 &&
      isPathInsideOrEqual(cwdFallbackPath, session.cwd))
}
