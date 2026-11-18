import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { sessionFileExecutionNamespace } from '../../../../shared/ai-vault/scanning/ai-vault-scope-cwd-match'

import { mapWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import { throwIfAiVaultScanCancelled } from '../../scan-lifecycle/ai-vault-scan-cancellation'
import { sessionSortTime } from '../../parsing/session-scanner-accumulator'

// Bridging and backfill expose one rollout through multiple roots; list only its canonical alias (#7521).

// Legacy names require content proof; canonical names encode immutable rollout identity.
const CODEX_ROLLOUT_FILE_NAME_PATTERN = /^rollout-.+\.jsonl(?:\.zst)?$/

// Hosts can scan foreign-platform paths, so handle both separators independently of node:path.
function lastPathSegment(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? ''
}

// Codex archives idle rollouts as .jsonl.zst and restores the .jsonl on resume, so both names alias one rollout.
function codexRolloutAliasName(fileName: string): string {
  return fileName.endsWith('.zst') ? fileName.slice(0, -'.zst'.length) : fileName
}

/** Returns null when both or neither alias is archived; otherwise whether `filePath` is the live one. */
function codexLiveAliasBeats(filePath: string, bestPath: string): boolean | null {
  const archived = filePath.endsWith('.zst')
  return archived === bestPath.endsWith('.zst') ? null : !archived
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const CANONICAL_ROLLOUT = new RegExp(
  `^rollout-(\\d{4}-\\d{2}-\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})-${UUID}(?:_${UUID})?\\.jsonl$`
)

export function canonicalCodexRolloutKey(filePath: string): string | null {
  const name = codexRolloutAliasName(lastPathSegment(filePath))
  const match = CANONICAL_ROLLOUT.exec(name)
  if (!match) {
    return null
  }
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.000Z`
  const time = Date.parse(iso)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== iso) {
    return null
  }
  return `${sessionFileExecutionNamespace(filePath)}\0${name}`
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
    // No filesystem assigns inode 0 to a file, so it cannot prove two paths share one.
    ino === 0
  ) {
    return null
  }
  return `${dev}:${ino}`
}

/** Prefer the real host home, then managed homes, so resume uses the canonical authentication lane. */
export function codexSessionRootRank(codexHome: string | null): number {
  if (codexHome === null) {
    return 0
  }
  const segments = codexHome.split(/[\\/]/).filter(Boolean)
  const isSharedRuntimeHome = segments.at(-2) === 'codex-runtime-home' && segments.at(-1) === 'home'
  const isPerAccountManagedHome = segments.at(-3) === 'codex-accounts' && segments.at(-1) === 'home'
  return isSharedRuntimeHome || isPerAccountManagedHome ? 1 : 2
}

/**
 * Proven hardlink aliases must not consume parse budget; same-name copies still need session-ID proof.
 * Returns `candidates` itself when none is an alias.
 */
export function dedupeCodexRolloutFileAliases<T>(
  candidates: T[],
  accessors: {
    isCodex: (candidate: T) => boolean
    getFilePath: (candidate: T) => string
    getCodexHome: (candidate: T) => string | null
    getHardlinkIdentity: (candidate: T) => string | null
  }
): T[] {
  let bestByAlias: Map<string, { candidate: T; rank: number; filePath: string }> | undefined
  let aliased = false
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
    bestByAlias ??= new Map()
    const best = bestByAlias.get(aliasKey)
    aliased ||= best !== undefined
    if (!best || rank < best.rank || (rank === best.rank && filePath < best.filePath)) {
      bestByAlias.set(aliasKey, { candidate, rank, filePath })
    }
  }
  if (!aliased || !bestByAlias) {
    return candidates
  }
  const aliases = bestByAlias
  return candidates.filter((candidate) => {
    if (!accessors.isCodex(candidate)) {
      return true
    }
    const fileName = lastPathSegment(accessors.getFilePath(candidate))
    const hardlinkIdentity = accessors.getHardlinkIdentity(candidate)
    if (!hardlinkIdentity) {
      return true
    }
    const best = aliases.get(
      `${sessionFileExecutionNamespace(accessors.getFilePath(candidate))}\0${fileName}\0${hardlinkIdentity}`
    )
    return !best || best.candidate === candidate
  })
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
    getHardlinkIdentity: (candidate: T) => string | null
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
    const key = `${sessionFileExecutionNamespace(filePath)}\0${codexRolloutAliasName(fileName)}`
    const group = groups.get(key)
    if (group) {
      group.push(candidate)
    } else {
      groups.set(key, [candidate])
    }
  }

  // Proven hardlinks need no read; compare inodes only within same-name groups.
  const aliasesToDrop = new Set<T>()
  const contested: T[] = []
  for (const [key, group] of groups) {
    if (group.length < 2) {
      continue
    }
    const physical = dedupeCodexRolloutFileAliases(group, accessors)
    if (physical !== group) {
      const kept = new Set(physical)
      for (const candidate of group) {
        if (!kept.has(candidate)) {
          aliasesToDrop.add(candidate)
        }
      }
      groups.set(key, physical)
    }
    // Batch across same-name groups so large mirrored histories do not serialize thousands of two-file reads.
    if (physical.length > 1) {
      contested.push(...physical)
    }
  }
  if (contested.length === 0) {
    return aliasesToDrop.size === 0
      ? [...candidates]
      : candidates.filter((candidate) => !aliasesToDrop.has(candidate))
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
      if (
        !best ||
        rank < best.rank ||
        (rank === best.rank &&
          (codexLiveAliasBeats(filePath, best.filePath) ?? filePath < best.filePath))
      ) {
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
  return `${session.executionHostId}\0${sessionFileExecutionNamespace(session.filePath)}\0${session.sessionId}\0${codexRolloutAliasName(fileName)}`
}

export function codexSessionAliasBeats(candidate: AiVaultSession, best: AiVaultSession): boolean {
  const candidateRank = codexSessionRootRank(candidate.codexHome)
  const bestRank = codexSessionRootRank(best.codexHome)
  if (candidateRank !== bestRank) {
    return candidateRank < bestRank
  }
  const live = codexLiveAliasBeats(candidate.filePath, best.filePath)
  if (live !== null) {
    return live
  }
  const candidateTime = sessionSortTime(candidate)
  const bestTime = sessionSortTime(best)
  if (candidateTime !== bestTime) {
    return candidateTime > bestTime
  }
  return candidate.filePath < best.filePath
}
