import type { AiVaultSession } from '../../shared/ai-vault-types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
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

/** Applies cheap hardlink proof before bounded cross-volume copy proof. */
export async function dedupeCodexRolloutAliases<T>(
  candidates: readonly T[],
  accessors: {
    isCodex: (candidate: T) => boolean
    getFilePath: (candidate: T) => string
    getCodexHome: (candidate: T) => string | null
    getHardlinkIdentity: (candidate: T) => string | null
    getSizeBytes?: (candidate: T) => number | undefined
  },
  readSessionMetaId: (filePath: string) => Promise<string | null>,
  signal?: AbortSignal
): Promise<T[]> {
  const hardlinkDeduped = dedupeCodexRolloutFileAliases(candidates, accessors)
  return dedupeCodexRolloutCopyAliases(hardlinkDeduped, accessors, readSessionMetaId, signal)
}

// Matches the scan's own parse batch width. UNC candidates are additionally
// serialized by the WSL transcript gate, so this only widens native reads.
const COPY_PROOF_READ_CONCURRENCY = 8

/**
 * Drops cross-volume rollout copies only when bounded session metadata proves
 * the same Codex session id and the files are the same size. Unreadable,
 * ambiguous, or diverged candidates remain for the full parser and its
 * post-parse identity check, which keeps the copy with the latest activity.
 */
export async function dedupeCodexRolloutCopyAliases<T>(
  candidates: readonly T[],
  accessors: {
    isCodex: (candidate: T) => boolean
    getFilePath: (candidate: T) => string
    getCodexHome: (candidate: T) => string | null
    getSizeBytes?: (candidate: T) => number | undefined
  },
  readSessionMetaId: (filePath: string) => Promise<string | null>,
  signal?: AbortSignal
): Promise<T[]> {
  const groups = new Map<string, T[]>()
  for (const candidate of candidates) {
    if (!accessors.isCodex(candidate)) {
      continue
    }
    const filePath = accessors.getFilePath(candidate)
    const fileName = lastPathSegment(filePath)
    if (!CODEX_ROLLOUT_FILE_NAME_PATTERN.test(fileName)) {
      continue
    }
    const key = `${codexPathExecutionNamespace(filePath)}\0${fileName}`
    const group = groups.get(key)
    if (group) {
      group.push(candidate)
    } else {
      groups.set(key, [candidate])
    }
  }

  // Only same-name groups can alias, so the read fans out across every
  // contested candidate at once rather than one group at a time — a corpus
  // with a full second history copy has thousands of two-file groups.
  const contested = [...groups.values()].filter((group) => group.length > 1).flat()
  if (contested.length === 0) {
    return [...candidates]
  }
  const identifiedIds = await mapWithConcurrency(
    contested,
    COPY_PROOF_READ_CONCURRENCY,
    async (candidate) => {
      throwIfAiVaultScanCancelled(signal)
      return readSessionMetaId(accessors.getFilePath(candidate))
    }
  )
  const idByCandidate = new Map<T, string | null>(
    contested.map((candidate, index) => [candidate, identifiedIds[index]])
  )

  const aliasesToDrop = new Set<T>()
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue
    }
    const bestByCopy = new Map<string, { candidate: T; rank: number; filePath: string }>()
    const copyKey = (candidate: T): string | null => {
      const id = idByCandidate.get(candidate)
      // Why size: a copy resumed in another home grows there while the original
      // stays frozen; root rank alone would hide the newer turns (#22478).
      return id ? `${id}\0${accessors.getSizeBytes?.(candidate) ?? ''}` : null
    }
    for (const candidate of group) {
      const key = copyKey(candidate)
      if (!key) {
        continue
      }
      const filePath = accessors.getFilePath(candidate)
      const rank = codexSessionRootRank(accessors.getCodexHome(candidate))
      const best = bestByCopy.get(key)
      if (!best || rank < best.rank || (rank === best.rank && filePath < best.filePath)) {
        bestByCopy.set(key, { candidate, rank, filePath })
      }
    }
    for (const candidate of group) {
      const key = copyKey(candidate)
      if (key && bestByCopy.get(key)?.candidate !== candidate) {
        aliasesToDrop.add(candidate)
      }
    }
  }
  return candidates.filter((candidate) => !aliasesToDrop.has(candidate))
}

export function codexSessionAliasKey(session: AiVaultSession): string | null {
  if (session.agent !== 'codex') {
    return null
  }
  const fileName = lastPathSegment(session.filePath)
  if (!CODEX_ROLLOUT_FILE_NAME_PATTERN.test(fileName)) {
    return null
  }
  return `${session.executionHostId}\0${codexPathExecutionNamespace(session.filePath)}\0${session.sessionId}\0${fileName}`
}

export function codexSessionAliasBeats(candidate: AiVaultSession, best: AiVaultSession): boolean {
  // Why content time before root rank: a diverged copy's last record is later;
  // identical copies tie here and keep the root preference (#22478).
  const candidateActivity = candidate.updatedAt ? Date.parse(candidate.updatedAt) : Number.NaN
  const bestActivity = best.updatedAt ? Date.parse(best.updatedAt) : Number.NaN
  if (
    !Number.isNaN(candidateActivity) &&
    !Number.isNaN(bestActivity) &&
    candidateActivity !== bestActivity
  ) {
    return candidateActivity > bestActivity
  }
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
