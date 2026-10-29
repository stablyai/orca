// Runtime partitions mirror a paired server, so main's per-repo topology fence must not outlive the
// race it guards: the window never echoes revisions, and a permanent fence froze its membership.
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { StoreRuntimeState } from './store-runtime-state'

// Why 10s: window saves debounce 150ms, but one already in flight or held by a closed persistence
// gate can land seconds after main's change; later saves have seen it. Monotonic, so clock steps can't shift it.
export const RUNTIME_PARTITION_TOPOLOGY_FENCE_MS = 10_000

type FenceOwner = Pick<StoreRuntimeState, 'state'>

/** Per store and runtime host: repo id -> when main last changed its terminal membership. */
const fencedAtByStore = new WeakMap<FenceOwner, Map<string, Map<string, number>>>()

function isRuntimePartition(hostId: ExecutionHostId): boolean {
  return parseExecutionHostId(hostId)?.kind === 'runtime'
}

function fencedRepos(owner: FenceOwner, hostId: ExecutionHostId): Map<string, number> {
  const byHost = fencedAtByStore.get(owner) ?? new Map<string, Map<string, number>>()
  const repos = byHost.get(hostId) ?? new Map<string, number>()
  byHost.set(hostId, repos)
  fencedAtByStore.set(owner, byHost)
  return repos
}

/** Main changed a runtime worktree's terminal membership itself (a removal, a recorded close). */
export function noteRuntimeTopologyChange(
  owner: FenceOwner,
  hostId: ExecutionHostId,
  worktreeId: string,
  now = performance.now()
): void {
  if (isRuntimePartition(hostId)) {
    fencedRepos(owner, hostId).set(getRepoIdFromWorktreeId(worktreeId), now)
  }
}

/** A write that raises a repo's revision is main's change; so is a legacy surface tombstone the
 *  sanitizer is about to retire. Either opens the fence for that repo. */
export function noteRuntimeRevisionRaises(
  owner: FenceOwner,
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  prior: WorkspaceSessionState | undefined,
  now = performance.now()
): void {
  if (!isRuntimePartition(hostId)) {
    return
  }
  const priorRevisions = prior?.terminalTopologyRevisionByRepoId ?? {}
  const repos = fencedRepos(owner, hostId)
  for (const [repoId, revision] of Object.entries(session.terminalTopologyRevisionByRepoId ?? {})) {
    if (revision > (priorRevisions[repoId] ?? 0)) {
      repos.set(repoId, now)
    }
  }
  for (const tombstone of [
    ...Object.values(prior?.terminalSurfaceTombstonesByPaneKey ?? {}),
    ...Object.values(session.terminalSurfaceTombstonesByPaneKey ?? {})
  ]) {
    repos.set(getRepoIdFromWorktreeId(tombstone.worktreeId), now)
  }
}

/** The prior a write rebases against: on a runtime partition, only repos main changed recently stay fenced. */
export function runtimePartitionFencePrior(
  owner: FenceOwner,
  hostId: ExecutionHostId,
  incoming: WorkspaceSessionState,
  prior: WorkspaceSessionState | undefined,
  now = performance.now()
): WorkspaceSessionState | undefined {
  if (!isRuntimePartition(hostId)) {
    return prior
  }
  const priorRevisions = prior?.terminalTopologyRevisionByRepoId ?? {}
  noteRuntimeRevisionRaises(owner, hostId, incoming, prior, now)
  const repos = fencedRepos(owner, hostId)
  if (!prior) {
    return prior
  }
  const fenced: Record<string, number> = {}
  for (const [repoId, revision] of Object.entries(priorRevisions)) {
    const fencedAt = repos.get(repoId)
    if (fencedAt !== undefined && now - fencedAt < RUNTIME_PARTITION_TOPOLOGY_FENCE_MS) {
      fenced[repoId] = revision
    }
  }
  return { ...prior, terminalTopologyRevisionByRepoId: fenced }
}

/** Window saves omit revisions; keep the highest so later main writes still order after earlier ones. */
export function keepRuntimePartitionRevisions(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  prior: WorkspaceSessionState | undefined
): WorkspaceSessionState {
  const priorRevisions = prior?.terminalTopologyRevisionByRepoId
  if (!isRuntimePartition(hostId) || !priorRevisions) {
    return session
  }
  const revisions = { ...session.terminalTopologyRevisionByRepoId }
  for (const [repoId, revision] of Object.entries(priorRevisions)) {
    revisions[repoId] = Math.max(revision, revisions[repoId] ?? 0)
  }
  return { ...session, terminalTopologyRevisionByRepoId: revisions }
}
