import type { AiVaultSession } from '../../shared/ai-vault-types'
import { sessionFileExecutionNamespace } from '../../shared/ai-vault-scope-cwd-match'
export { sessionFileExecutionNamespace } from '../../shared/ai-vault-scope-cwd-match'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { sessionSortTime } from './session-scanner-accumulator'

// Bridging and backfill expose one rollout through multiple roots; list only its canonical alias (#7521).

// Rollout names narrow candidates; inode or parsed session ID must still prove identity.
const CODEX_ROLLOUT_FILE_NAME_PATTERN = /^rollout-.+\.jsonl$/

// Hosts can scan foreign-platform paths, so handle both separators independently of node:path.
function lastPathSegment(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? ''
}

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

/** Prefer the real host home, then managed homes, so resume uses the canonical authentication lane. */
function codexSessionRootRank(codexHome: string | null): number {
  if (codexHome === null) {
    return 0
  }
  const segments = codexHome.split(/[\\/]/).filter(Boolean)
  const isSharedRuntimeHome = segments.at(-2) === 'codex-runtime-home' && segments.at(-1) === 'home'
  const isPerAccountManagedHome = segments.at(-3) === 'codex-accounts' && segments.at(-1) === 'home'
  return isSharedRuntimeHome || isPerAccountManagedHome ? 1 : 2
}

/** Proven hardlink aliases must not consume parse budget; same-name copies still need session-ID proof. */
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
    const aliasKey = `${sessionFileExecutionNamespace(filePath)}\0${fileName}\0${hardlinkIdentity}`
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
      `${sessionFileExecutionNamespace(accessors.getFilePath(candidate))}\0${fileName}\0${hardlinkIdentity}`
    )
    return !best || best.candidate === candidate
  })
}

export async function dedupeCodexRolloutAliases<T>(
  candidates: readonly T[],
  accessors: {
    isCodex: (candidate: T) => boolean
    getFilePath: (candidate: T) => string
    getCodexHome: (candidate: T) => string | null
    getHardlinkIdentity: (candidate: T) => string | null
  },
  readSessionMetaId: (filePath: string) => Promise<string | null>,
  signal?: AbortSignal
): Promise<T[]> {
  const hardlinkDeduped = dedupeCodexRolloutFileAliases(candidates, accessors)
  return dedupeCodexRolloutCopyAliases(hardlinkDeduped, accessors, readSessionMetaId, signal)
}

// Match parse batch width; the WSL transcript gate separately serializes UNC reads.
const COPY_PROOF_READ_CONCURRENCY = 8

/** Bounded metadata must prove copy identity; unreadable or ambiguous files stay for full parsing. */
export async function dedupeCodexRolloutCopyAliases<T>(
  candidates: readonly T[],
  accessors: {
    isCodex: (candidate: T) => boolean
    getFilePath: (candidate: T) => string
    getCodexHome: (candidate: T) => string | null
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
    const key = `${sessionFileExecutionNamespace(filePath)}\0${fileName}`
    const group = groups.get(key)
    if (group) {
      group.push(candidate)
    } else {
      groups.set(key, [candidate])
    }
  }

  // Batch across same-name groups so large mirrored histories do not serialize thousands of two-file reads.
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
    const bestById = new Map<string, { candidate: T; rank: number; filePath: string }>()
    for (const candidate of group) {
      const id = idByCandidate.get(candidate)
      if (!id) {
        continue
      }
      const filePath = accessors.getFilePath(candidate)
      const rank = codexSessionRootRank(accessors.getCodexHome(candidate))
      const best = bestById.get(id)
      if (!best || rank < best.rank || (rank === best.rank && filePath < best.filePath)) {
        bestById.set(id, { candidate, rank, filePath })
      }
    }
    for (const candidate of group) {
      const id = idByCandidate.get(candidate)
      if (id && bestById.get(id)?.candidate !== candidate) {
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
  return `${session.executionHostId}\0${sessionFileExecutionNamespace(session.filePath)}\0${session.sessionId}\0${fileName}`
}

export function codexSessionAliasBeats(candidate: AiVaultSession, best: AiVaultSession): boolean {
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
