/**
 * After quiesce, proof that no terminal of a moved workspace still runs on this desktop's daemon
 * (mover design, section 3.3). The local daemon can prove exit, so only a census it answered can
 * say `exited`; one it could not answer is `unverifiable`, never a guess (AGENTS.md: SSH Use Case).
 */
import { parsePtySessionId, WORKTREE_ID_SEPARATOR } from '../../../shared/pty-session-id-format'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import type { SessionInfo } from '../../daemon/types'

export type WslMoveExitProof =
  | { verdict: 'exited' }
  | { verdict: 'live'; sessionIds: string[] }
  | { verdict: 'unverifiable'; reason: string }

export type WslMoveExitProofSources = {
  /** `listLiveDaemonSessions`: null unless every daemon generation answered. */
  listSessions: () => Promise<readonly Pick<SessionInfo, 'sessionId' | 'isAlive'>[] | null>
  /** In-process fallback PTYs from degraded mode, which no daemon census lists. */
  countFallbackSessions: () => number
}

export async function proveWslMoveTerminalsExited(
  sources: WslMoveExitProofSources,
  scope: {
    /** Workspace keys as session ids mint them: `<repoId>::<path>` or `folder:<id>`. */
    workspaceKeys: ReadonlySet<string>
    /** The ids the moved panes recorded; covers a session whose id predates the minted format. */
    sessionIds: ReadonlySet<string>
  }
): Promise<WslMoveExitProof> {
  let sessions: readonly Pick<SessionInfo, 'sessionId' | 'isAlive'>[] | null
  try {
    sessions = await sources.listSessions()
  } catch (error) {
    return {
      verdict: 'unverifiable',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  if (sessions === null) {
    return { verdict: 'unverifiable', reason: 'a daemon generation did not answer' }
  }
  if (sources.countFallbackSessions() > 0) {
    return { verdict: 'unverifiable', reason: 'terminals are running outside the daemon' }
  }
  const scopeKeys = new Set([...scope.workspaceKeys].map(comparableWorkspaceKey))
  const live = sessions
    .filter((session) => {
      if (!session.isAlive) {
        return false
      }
      if (scope.sessionIds.has(session.sessionId)) {
        return true
      }
      const { worktreeId } = parsePtySessionId(session.sessionId)
      return worktreeId !== null && scopeKeys.has(comparableWorkspaceKey(worktreeId))
    })
    .map((session) => session.sessionId)
  return live.length > 0 ? { verdict: 'live', sessionIds: live } : { verdict: 'exited' }
}

// `\\wsl$` and `\\wsl.localhost`, and any distro-name case, reach the same folder; the Linux part
// stays case-sensitive.
function comparableWorkspaceKey(key: string): string {
  const separator = key.indexOf(WORKTREE_ID_SEPARATOR)
  if (separator <= 0) {
    return key
  }
  const unc = parseWslUncPath(key.slice(separator + WORKTREE_ID_SEPARATOR.length))
  return unc
    ? `${key.slice(0, separator)}${WORKTREE_ID_SEPARATOR}wsl:${unc.distro.toLowerCase()}:${unc.linuxPath}`
    : key
}
