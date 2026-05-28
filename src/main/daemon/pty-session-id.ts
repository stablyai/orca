import { randomUUID } from 'crypto'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { PTY_SESSION_ID_SEPARATOR } from '../../shared/pty-session-id-format'

// Why: re-exported here so main-side callers can keep importing
// `parsePtySessionId` from this module (next to `mintPtySessionId`). The
// implementation lives in `src/shared/` because the renderer-side merge
// helper also needs it and cannot import node-only modules.
export { parsePtySessionId } from '../../shared/pty-session-id-format'

/**
 * Session IDs use the format `${worktreeId}@@${shortUuid}` so that
 * DaemonPtyAdapter.reconcileOnStartup (see daemon-pty-adapter.ts) can
 * derive the owning worktree by splitting on the @@ separator.
 *
 * Both pty.ts (host-daemon spawn path) and DaemonPtyAdapter.doSpawn
 * (fallback when opts.sessionId is absent) must use this helper — a
 * drifted format would break cold-restore mapping and Pi overlay
 * keying.
 */
export function mintPtySessionId(worktreeId?: string): string {
  return worktreeId
    ? `${worktreeId}${PTY_SESSION_ID_SEPARATOR}${randomUUID().slice(0, 8)}`
    : randomUUID()
}

/**
 * Why: `effectiveSessionId` is used as a filesystem key (Pi overlay
 * directory under app.getPath('userData')). The security property we
 * want is containment: the derived overlay path must be strictly
 * inside the userData root so a crafted IPC payload (args.sessionId
 * or args.worktreeId forwarded from the renderer) cannot make us
 * write overlay files outside userData.
 *
 * Callers pass `app.getPath('userData')` as `userDataPath`. Any
 * subpath inside userData is acceptable as a filesystem key since
 * the Pi overlay path lives deeper inside userData — enforcing
 * "id cannot escape userData" is a superset of "id cannot escape Pi
 * overlay root".
 *
 * Note: real worktreeIds are `${repo.id}::${absolutePath}` so minted
 * session ids contain `/` on POSIX and `\` on Windows. Rejecting
 * those chars outright would break every real daemon spawn with a
 * worktree. We instead compute `join(userDataPath, id)` and assert
 * the normalized result is a strict subpath — this rejects `..`
 * sequences, absolute-path injection, and NUL truncation attacks
 * without false positives on legitimate path-shaped ids.
 */
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
  // Why: `path.relative` can return an absolute path when the target lives
  // on a different drive or under a UNC share on Windows (e.g. relative
  // from C:\userdata to D:\evil yields "D:\evil", which does NOT start with
  // ".."). Reject any absolute result — a legitimate subpath under
  // userData always produces a relative result on every platform.
  if (rel === '' || isAbsolute(rel) || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    return false
  }
  return true
}
