// Require a complete daemon census under the move fence; unavailable evidence cannot prove exit.
import { parsePtySessionId, WORKTREE_ID_SEPARATOR } from '../../../shared/pty-session-id-format'
import { foldWslUncPathCaseInsensitiveParts, toWindowsWslUncPath } from '../../../shared/wsl-paths'
import type { SessionInfo } from '../../daemon/types'

export type WslMoveExitProof =
  | { verdict: 'exited' }
  | { verdict: 'live'; sessionIds: string[] }
  | { verdict: 'unverifiable'; reason: string }

type CensusSession = Pick<SessionInfo, 'sessionId' | 'isAlive' | 'cwd' | 'wslDistro'>

export type WslMoveExitProofSources = {
  /** Null unless every daemon generation answered. */
  listSessions: () => Promise<readonly CensusSession[] | null>
  /** Degraded-mode PTYs absent from daemon censuses. */
  countFallbackSessions: () => number
  isScopeFenced: () => boolean
}

export type WslMoveExitProofScope = {
  distro: string
  /** Session workspace keys: <repoId>::<path> or folder:<id>. */
  workspaceKeys: ReadonlySet<string>
  /** Cover sessions whose IDs predate the minted workspace format. */
  sessionIds: ReadonlySet<string>
}

type Attribution = 'in-scope' | 'elsewhere' | 'unknown'

export async function proveWslMoveTerminalsExited(
  sources: WslMoveExitProofSources,
  scope: WslMoveExitProofScope
): Promise<WslMoveExitProof> {
  let sessions: readonly CensusSession[] | null
  let fallbackSessions: number
  try {
    if (!sources.isScopeFenced()) {
      return { verdict: 'unverifiable', reason: 'new terminals are not fenced for the move' }
    }
    sessions = await sources.listSessions()
    fallbackSessions = sources.countFallbackSessions()
    if (!sources.isScopeFenced()) {
      return { verdict: 'unverifiable', reason: 'the move fence lifted during the census' }
    }
  } catch (error) {
    return {
      verdict: 'unverifiable',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  if (sessions === null) {
    return { verdict: 'unverifiable', reason: 'a daemon generation did not answer' }
  }
  if (fallbackSessions > 0) {
    return { verdict: 'unverifiable', reason: 'terminals are running outside the daemon' }
  }
  const { distro } = scope
  const scopeKeys = new Set([...scope.workspaceKeys].map((key) => comparableKey(key, distro)))
  const roots = [...scope.workspaceKeys].flatMap((key) => {
    const path = keyPath(key)
    const root = path === null ? null : comparableWslPath(path, distro)
    return root === null ? [] : [root]
  })
  const live: string[] = []
  const unattributed: string[] = []
  for (const session of sessions) {
    if (!session.isAlive) {
      continue
    }
    const attribution = attributeSession(session, scope, scopeKeys, roots)
    if (attribution === 'in-scope') {
      live.push(session.sessionId)
    } else if (attribution === 'unknown') {
      unattributed.push(session.sessionId)
    }
  }
  if (live.length > 0) {
    return { verdict: 'live', sessionIds: live }
  }
  return unattributed.length > 0
    ? {
        verdict: 'unverifiable',
        reason: `live terminals with no known workspace: ${unattributed.join(', ')}`
      }
    : { verdict: 'exited' }
}

function attributeSession(
  session: CensusSession,
  scope: WslMoveExitProofScope,
  scopeKeys: ReadonlySet<string>,
  roots: readonly string[]
): Attribution {
  if (scope.sessionIds.has(session.sessionId)) {
    return 'in-scope'
  }
  const { worktreeId } = parsePtySessionId(session.sessionId)
  if (worktreeId !== null) {
    if (scopeKeys.has(comparableKey(worktreeId, scope.distro))) {
      return 'in-scope'
    }
    // Another workspace's shell can still have changed into a moved folder.
    return attributeByCwd(session, scope.distro, roots) === 'in-scope' ? 'in-scope' : 'elsewhere'
  }
  return attributeByCwd(session, scope.distro, roots)
}

// Without workspace identity, cwd is the only attribution evidence.
function attributeByCwd(
  session: CensusSession,
  distro: string,
  roots: readonly string[]
): Attribution {
  const { cwd, wslDistro } = session
  if (!cwd) {
    return 'unknown'
  }
  const inDistro = typeof wslDistro === 'string' && sameDistro(wslDistro, distro)
  const path = comparableWslPath(cwd, distro)
  const underRoot = path !== null && roots.some((root) => isAtOrUnder(path, root))
  // POSIX cwd alone cannot distinguish native Git Bash from wsl.exe sessions.
  if (isLinuxSpelled(cwd) && !inDistro) {
    return wslDistro === undefined || (wslDistro === null && underRoot) ? 'unknown' : 'elsewhere'
  }
  if (underRoot) {
    return 'in-scope'
  }
  const distroRoot = comparableWslPath('/', distro)
  const pathInDistro = path !== null && distroRoot !== null && isAtOrUnder(path, distroRoot)
  return inDistro || pathInDistro ? 'unknown' : 'elsewhere'
}

function keyPath(key: string): string | null {
  const separator = key.indexOf(WORKTREE_ID_SEPARATOR)
  return separator <= 0 ? null : key.slice(separator + WORKTREE_ID_SEPARATOR.length)
}

// Canonicalize distro case, UNC aliases, Linux spelling and trailing separators.
function comparableKey(key: string, distro: string): string {
  const path = keyPath(key)
  const comparable = path === null ? null : comparableWslPath(path, distro)
  if (comparable === null) {
    return key
  }
  return `${key.slice(0, key.indexOf(WORKTREE_ID_SEPARATOR))}${WORKTREE_ID_SEPARATOR}${comparable}`
}

function comparableWslPath(path: string, distro: string): string | null {
  const unc = isLinuxSpelled(path) ? toWindowsWslUncPath(path, distro) : path
  return foldWslUncPathCaseInsensitiveParts(unc)?.replace(/\/+$/, '') ?? null
}

function isLinuxSpelled(path: string): boolean {
  return /^\/(?!\/)/.test(path)
}

function isAtOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

function sameDistro(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}
