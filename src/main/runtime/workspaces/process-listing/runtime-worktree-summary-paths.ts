import type { RuntimeWorktreePsSummary } from '../../../../shared/runtime-worktree-contracts'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import { worktreePathComparisonKey } from '../../../workspaces/catalog/worktree-path-comparison-key'
import { parseRuntimeWorktreeId } from '../catalog/runtime-worktree-path-identity'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { isLocalHookConnectionId } from '../../../../shared/wsl-hook-relay-contract'

type RuntimeWorktreeSummaryPathCandidate = { summary: RuntimeWorktreePsSummary; order: number }
/** One candidate per host, first registration first. */
type RuntimeWorktreeSummaryPathCandidates = RuntimeWorktreeSummaryPathCandidate[]

export type RuntimeWorktreeSummaryPathIndex = {
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
  posixAbsolute: Map<string, RuntimeWorktreeSummaryPathCandidates>
  posixRelative: Map<string, RuntimeWorktreeSummaryPathCandidates>
  windows: Map<string, RuntimeWorktreeSummaryPathCandidates>
  windowsAbsolute: Map<string, RuntimeWorktreeSummaryPathCandidates>
}

/** Same-id rows on different hosts are separate rows. */
export function runtimeWorktreePsRowKey(
  row: Pick<RuntimeWorktreePsSummary, 'worktreeId' | 'hostId'>
): string {
  return `${row.hostId ?? ''}\0${row.worktreeId}`
}

export function buildRuntimeWorktreeSummaryPathIndex(
  summaries: ReadonlyMap<string, RuntimeWorktreePsSummary>,
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
): RuntimeWorktreeSummaryPathIndex {
  const index: RuntimeWorktreeSummaryPathIndex = {
    platformByRepoId,
    posixAbsolute: new Map(),
    posixRelative: new Map(),
    windows: new Map(),
    windowsAbsolute: new Map()
  }
  let order = 0
  for (const summary of summaries.values()) {
    if (summary.workspaceKind === 'folder-workspace') {
      continue
    }
    const platform = platformByRepoId.get(summary.repoId) ?? process.platform
    const candidate = { summary, order: order++ }
    if (isPosixAbsoluteRuntimeWorktreePath(summary.path)) {
      addRuntimeWorktreePathCandidate(
        index.posixAbsolute,
        runtimeWorktreeSummaryPathKey(summary.repoId, summary.path, platform),
        candidate
      )
      continue
    }
    const windowsKey = runtimeWorktreeSummaryPathKey(summary.repoId, summary.path, 'win32')
    addRuntimeWorktreePathCandidate(index.windows, windowsKey, candidate)
    if (isWindowsAbsolutePathLike(summary.path)) {
      addRuntimeWorktreePathCandidate(index.windowsAbsolute, windowsKey, candidate)
    } else if (platform !== 'win32') {
      addRuntimeWorktreePathCandidate(
        index.posixRelative,
        runtimeWorktreeSummaryPathKey(summary.repoId, summary.path, platform),
        candidate
      )
    }
  }
  return index
}

/** The host an activity's connection proves; a wsl: stamp is this machine's own relay, not SSH. */
export function connectionEvidenceHostId(connectionId: string | null): ExecutionHostId {
  return isLocalHookConnectionId(connectionId)
    ? LOCAL_EXECUTION_HOST_ID
    : getConnectionExecutionHostId(connectionId)
}

/** `hostId` is the activity's own host evidence; omit it when the evidence names no host. */
export type RuntimeWorktreePsSummaryLookup = (
  worktreeId: string,
  hostId?: ExecutionHostId
) => RuntimeWorktreePsSummary | null

/** A raw id attaches to its only row, as before; among same-id rows only the provable host copy. */
function pickHostCopy<T extends { summary: RuntimeWorktreePsSummary }>(
  candidates: readonly T[] | undefined,
  hostId: ExecutionHostId | undefined
): T | null | undefined {
  if (!candidates || candidates.length <= 1) {
    return candidates?.[0]
  }
  const matches = hostId
    ? candidates.filter((candidate) => candidate.summary.hostId === hostId)
    : []
  return matches.length === 1 ? matches[0] : null
}

export function createRuntimeWorktreePsSummaryLookup(
  summaries: ReadonlyMap<string, RuntimeWorktreePsSummary>,
  pathIndex: RuntimeWorktreeSummaryPathIndex
): RuntimeWorktreePsSummaryLookup {
  const byId = new Map<string, { summary: RuntimeWorktreePsSummary }[]>()
  for (const summary of summaries.values()) {
    byId.set(summary.worktreeId, [...(byId.get(summary.worktreeId) ?? []), { summary }])
  }
  const missing = new Set<string>()
  return (worktreeId, hostId) => {
    const exact = pickHostCopy(byId.get(worktreeId), hostId)
    if (exact !== undefined) {
      return exact?.summary ?? null
    }
    const missKey = `${hostId ?? ''}\0${worktreeId}`
    if (missing.has(missKey)) {
      return null
    }
    const parsed = parseRuntimeWorktreeId(worktreeId)
    if (!parsed) {
      return null
    }
    const platform = pathIndex.platformByRepoId.get(parsed.repoId) ?? process.platform
    const indexed = findRuntimeWorktreeSummaryByPath(
      pathIndex,
      parsed.repoId,
      parsed.worktreePath,
      platform,
      hostId
    )
    if (indexed) {
      return indexed
    }
    missing.add(missKey)
    return null
  }
}

export function findRuntimeWorktreeSummaryByPath(
  index: RuntimeWorktreeSummaryPathIndex,
  repoId: string,
  worktreePath: string,
  platform: NodeJS.Platform,
  hostId?: ExecutionHostId
): RuntimeWorktreePsSummary | null {
  if (isPosixAbsoluteRuntimeWorktreePath(worktreePath)) {
    return (
      pickHostCopy(
        index.posixAbsolute.get(runtimeWorktreeSummaryPathKey(repoId, worktreePath, platform)),
        hostId
      )?.summary ?? null
    )
  }
  const windowsKey = runtimeWorktreeSummaryPathKey(repoId, worktreePath, 'win32')
  if (platform === 'win32' || isWindowsAbsolutePathLike(worktreePath)) {
    return pickHostCopy(index.windows.get(windowsKey), hostId)?.summary ?? null
  }
  const posixCandidate = pickHostCopy(
    index.posixRelative.get(runtimeWorktreeSummaryPathKey(repoId, worktreePath, platform)),
    hostId
  )
  const windowsCandidate = pickHostCopy(index.windowsAbsolute.get(windowsKey), hostId)
  // Malformed paths can match both indexes; preserve the pairwise scan's first-match order.
  if (!posixCandidate) {
    return windowsCandidate?.summary ?? null
  }
  if (!windowsCandidate || posixCandidate.order < windowsCandidate.order) {
    return posixCandidate.summary
  }
  return windowsCandidate.summary
}

function addRuntimeWorktreePathCandidate(
  candidates: Map<string, RuntimeWorktreeSummaryPathCandidates>,
  key: string,
  candidate: RuntimeWorktreeSummaryPathCandidate
): void {
  const existing = candidates.get(key)
  if (!existing) {
    candidates.set(key, [candidate])
  } else if (!existing.some((entry) => entry.summary.hostId === candidate.summary.hostId)) {
    existing.push(candidate)
  }
}

function isPosixAbsoluteRuntimeWorktreePath(worktreePath: string): boolean {
  return worktreePath.startsWith('/') && !worktreePath.startsWith('//')
}

function runtimeWorktreeSummaryPathKey(
  repoId: string,
  worktreePath: string,
  platform: NodeJS.Platform
): string {
  return `${repoId}\0${worktreePathComparisonKey(worktreePath, platform)}`
}
