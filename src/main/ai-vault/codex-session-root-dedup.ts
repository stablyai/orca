import type { AiVaultSession } from '../../shared/ai-vault-types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { sessionSortTime } from './session-scanner-accumulator'

// Why: the session bridge and the real-home backfill hardlink one physical
// Codex rollout into multiple scanned roots (managed runtime home and the
// user's own ~/.codex), so every bridged/backfilled session used to list once
// per root (#7521). These helpers collapse those aliases to one canonical row.

// Matches Codex rollout logs: rollout-<timestamp>-<session uuid>.jsonl. The
// bridge and backfill preserve the name, but the name alone is not identity:
// pre-parse dedup also requires a shared inode and post-parse requires the id.
const CODEX_ROLLOUT_FILE_NAME_PATTERN = /^rollout-.+\.jsonl$/

// Why: not node:path.basename — a posix host scans remote/WSL win32 paths, so
// separators must be handled independently of the local platform.
function lastPathSegment(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? ''
}

// Why: local Windows discovery scans both the host and every WSL distro under
// one `local` host id, even though hardlinks and resume identity cannot cross
// those execution boundaries.
function codexPathExecutionNamespace(filePath: string): string {
  const wslPath = parseWslUncPath(filePath)
  return wslPath ? `wsl:${wslPath.distro.toLowerCase()}` : 'native'
}

/** Returns a pre-parse alias key only when metadata proves a shared hardlink. */
export function codexRolloutHardlinkIdentity(file: {
  dev?: number
  ino?: number
  nlink?: number
}): string | null {
  const { dev, ino, nlink } = file
  if (
    typeof dev !== 'number' ||
    typeof ino !== 'number' ||
    typeof nlink !== 'number' ||
    !Number.isSafeInteger(dev) ||
    !Number.isSafeInteger(ino) ||
    !Number.isSafeInteger(nlink) ||
    nlink <= 1 ||
    (dev === 0 && ino === 0)
  ) {
    return null
  }
  return `${dev}:${ino}`
}

/**
 * Ranks a Codex session root for canonical-alias selection, lowest wins.
 *
 * Host real home (null) is canonical: after the real-home flip the managed
 * home's auth.json is no longer refreshed, so resume must not stamp it. The
 * Orca managed runtime home and each per-account self-contained home
 * (codex-accounts/<id>/home) beat other homes (WSL/remote real homes, custom
 * CODEX_HOMEs) because those are the roots codex actually refreshes for their
 * lane — the shared runtime home for the managed mirror, and the per-account
 * home once a managed account launches directly against it.
 */
function codexSessionRootRank(codexHome: string | null): number {
  if (codexHome === null) {
    return 0
  }
  const segments = codexHome.split(/[\\/]/).filter(Boolean)
  const isSharedRuntimeHome = segments.at(-2) === 'codex-runtime-home' && segments.at(-1) === 'home'
  const isPerAccountManagedHome = segments.at(-3) === 'codex-accounts' && segments.at(-1) === 'home'
  return isSharedRuntimeHome || isPerAccountManagedHome ? 1 : 2
}

/**
 * Drops pre-parse Codex rollout candidates that alias an already-kept rollout
 * hardlink in a preferred root, so proven aliases never consume the parse
 * budget. Same-name copies remain until parsed identity proves they alias.
 */
export function dedupeCodexRolloutFileAliases<T>(
  candidates: readonly T[],
  accessors: {
    isCodex: (candidate: T) => boolean
    getFilePath: (candidate: T) => string
    getCodexHome: (candidate: T) => string | null
    getHardlinkIdentity: (candidate: T) => string | null
  }
): T[] {
  const bestByAlias = new Map<string, { candidate: T; rank: number; filePath: string }>()
  for (const candidate of candidates) {
    if (!accessors.isCodex(candidate)) {
      continue
    }
    const filePath = accessors.getFilePath(candidate)
    const fileName = lastPathSegment(filePath)
    if (!CODEX_ROLLOUT_FILE_NAME_PATTERN.test(fileName)) {
      continue
    }
    const hardlinkIdentity = accessors.getHardlinkIdentity(candidate)
    if (!hardlinkIdentity) {
      continue
    }
    const aliasKey = `${codexPathExecutionNamespace(filePath)}\0${fileName}\0${hardlinkIdentity}`
    const rank = codexSessionRootRank(accessors.getCodexHome(candidate))
    const best = bestByAlias.get(aliasKey)
    if (!best || rank < best.rank || (rank === best.rank && filePath < best.filePath)) {
      bestByAlias.set(aliasKey, { candidate, rank, filePath })
    }
  }
  return candidates.filter((candidate) => {
    if (!accessors.isCodex(candidate)) {
      return true
    }
    const fileName = lastPathSegment(accessors.getFilePath(candidate))
    const hardlinkIdentity = accessors.getHardlinkIdentity(candidate)
    if (!hardlinkIdentity) {
      return true
    }
    const best = bestByAlias.get(
      `${codexPathExecutionNamespace(accessors.getFilePath(candidate))}\0${fileName}\0${hardlinkIdentity}`
    )
    return !best || best.candidate === candidate
  })
}

/**
 * Collapses parsed Codex sessions that share a rollout name and session id on
 * one execution host, keeping the canonical root's row. Requiring both the
 * parsed id and rollout name preserves id collisions and same-name files whose
 * parsed ids differ.
 */
export function dedupeCodexSessionsBySessionId(
  sessions: readonly AiVaultSession[]
): AiVaultSession[] {
  const bestByKey = new Map<string, AiVaultSession>()
  for (const session of sessions) {
    const key = codexSessionAliasKey(session)
    if (!key) {
      continue
    }
    const best = bestByKey.get(key)
    if (!best || codexSessionAliasBeats(session, best)) {
      bestByKey.set(key, session)
    }
  }
  return sessions.filter((session) => {
    const key = codexSessionAliasKey(session)
    if (!key) {
      return true
    }
    return bestByKey.get(key) === session
  })
}

function codexSessionAliasKey(session: AiVaultSession): string | null {
  if (session.agent !== 'codex') {
    return null
  }
  const fileName = lastPathSegment(session.filePath)
  if (!CODEX_ROLLOUT_FILE_NAME_PATTERN.test(fileName)) {
    return null
  }
  return `${session.executionHostId}\0${codexPathExecutionNamespace(session.filePath)}\0${session.sessionId}\0${fileName}`
}

function codexSessionAliasBeats(candidate: AiVaultSession, best: AiVaultSession): boolean {
  const candidateRank = codexSessionRootRank(candidate.codexHome)
  const bestRank = codexSessionRootRank(best.codexHome)
  if (candidateRank !== bestRank) {
    return candidateRank < bestRank
  }
  const candidateTime = sessionSortTime(candidate)
  const bestTime = sessionSortTime(best)
  if (candidateTime !== bestTime) {
    return candidateTime > bestTime
  }
  return candidate.filePath < best.filePath
}
