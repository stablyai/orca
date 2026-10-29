import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PTY_SESSION_ID_SEPARATOR } from '../../shared/pty-session-id-format'

/** Keep session-ID format aligned so cold restore and legacy cleanup recover the owning workspace. */
export function mintPtySessionId(worktreeId?: string): string {
  return worktreeId
    ? `${worktreeId}${PTY_SESSION_ID_SEPARATOR}${randomUUID().slice(0, 8)}`
    : randomUUID()
}

export function ptySessionIdForAgentCreateOperation(
  worktreeId: string | undefined,
  operationId: string
): string {
  // Preserve the legacy eight-character suffix budget for maximum-length workspace IDs.
  const suffix = operationId.slice(0, 8)
  return worktreeId ? `${worktreeId}${PTY_SESSION_ID_SEPARATOR}${suffix}` : suffix
}

/** Session IDs may contain workspace paths; require their derived key to stay strictly inside userData. */
export function isSafePtySessionId(id: string, userDataPath: string): boolean {
  if (id.length === 0 || id.length > 512) {
    return false
  }
  if (id.includes('\0')) {
    return false
  }
  const resolvedRoot = resolve(userDataPath)
  const resolvedTarget = resolve(join(userDataPath, id))
  const rel = relative(resolvedRoot, resolvedTarget)
  // Reject absolute Windows cross-drive or UNC results from relative(), even without a .. prefix.
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    return false
  }
  return true
}
