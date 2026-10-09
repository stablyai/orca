import type { WorkspaceAttachmentMutation } from '../../../shared/workspace-attachment-mutation'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  composeWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { setWorktreeMetaForHost } from './worktree-identity-metadata'
import { indexMetadataAliasesForWorktreeIds } from '../tracking-repos/local-worktree-metadata-scan-expectation'

type MetadataRuntime = Pick<StoreRuntimeState, 'state'>

export type WorktreeMetadataExpectation = {
  executionHostId?: ExecutionHostId
  instanceId?: string
}

export type ExistingWorktreeMetadataUpdate = {
  worktreeId: string
  updates: Partial<WorktreeMeta> & WorkspaceAttachmentMutation
}

function metadataOwnerHosts(
  state: PersistedState,
  worktreeId: string,
  aliases: readonly string[] = Object.keys(state.worktreeIdentityAliases ?? {}),
  repoHosts?: Iterable<ExecutionHostId>
): Set<ExecutionHostId> {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const hosts = new Set(
    repoHosts ?? state.repos.filter((repo) => repo.id === repoId).map(getRepoExecutionHostId)
  )
  const legacyHost = state.worktreeMeta[worktreeId]?.hostId
  if (legacyHost) {
    hosts.add(legacyHost)
  }
  for (const alias of aliases) {
    if (getWorktreeIdFromHostIdentity(alias) === worktreeId) {
      const host = getExecutionHostIdFromWorktreeHostIdentity(alias)
      if (host) {
        hosts.add(host)
      }
    }
  }
  return hosts
}

function existingMutationTarget(
  state: PersistedState,
  worktreeId: string,
  expectation: WorktreeMetadataExpectation,
  knownHosts?: ReadonlySet<ExecutionHostId>
): { meta: WorktreeMeta; executionHostId: ExecutionHostId } | undefined {
  let executionHostId = expectation.executionHostId
  let hosts = knownHosts
  if (!executionHostId) {
    hosts ??= metadataOwnerHosts(state, worktreeId)
    if (hosts.size > 1) {
      return undefined
    }
    executionHostId = [...hosts][0] ?? LOCAL_EXECUTION_HOST_ID
  }
  const alias = composeWorktreeHostIdentity(executionHostId, worktreeId)
  const keys = state.worktreeIdentityAliases?.[alias] ?? []
  if (keys.length > 1) {
    return undefined
  }
  const key = keys[0]
  const legacy = state.worktreeMeta[worktreeId]
  if (!key && legacy && !legacy.hostId) {
    hosts ??= metadataOwnerHosts(state, worktreeId)
    if (
      hosts.size > 1 ||
      (hosts.size === 1 && !hosts.has(executionHostId)) ||
      (hosts.size === 0 && executionHostId !== LOCAL_EXECUTION_HOST_ID)
    ) {
      return undefined
    }
  }
  const meta = key
    ? state.worktreeMetaByIdentity?.[key]
    : !legacy?.hostId || legacy.hostId === executionHostId
      ? legacy
      : undefined
  if (
    !meta ||
    (meta.hostId && meta.hostId !== executionHostId) ||
    (expectation.instanceId !== undefined && meta.instanceId !== expectation.instanceId)
  ) {
    return undefined
  }
  return { meta, executionHostId }
}

/** Membership checks must not backfill identity or schedule a write for a stale request. */
export function isCurrentWorktreeMetadata(
  runtime: MetadataRuntime,
  worktreeId: string,
  expectation: WorktreeMetadataExpectation,
  updates: Partial<WorktreeMeta> = {}
): boolean {
  const target = existingMutationTarget(runtime.state, worktreeId, expectation)
  return target !== undefined && metadataUpdatePreservesOccupant(target, updates)
}

function metadataUpdatePreservesOccupant(
  target: { meta: WorktreeMeta; executionHostId: ExecutionHostId },
  updates: Partial<WorktreeMeta>
): boolean {
  return (
    (updates.instanceId === undefined || updates.instanceId === target.meta.instanceId) &&
    (updates.hostId === undefined || updates.hostId === target.executionHostId)
  )
}

export function updateExistingWorktreeMeta(
  runtime: MetadataRuntime,
  scheduling: WriteSchedulingOperations,
  worktreeId: string,
  meta: Partial<WorktreeMeta> & WorkspaceAttachmentMutation,
  expectation: WorktreeMetadataExpectation
): WorktreeMeta | undefined {
  const target = existingMutationTarget(runtime.state, worktreeId, expectation)
  if (!target || !metadataUpdatePreservesOccupant(target, meta)) {
    return undefined
  }
  return setWorktreeMetaForHost(runtime, scheduling, worktreeId, target.executionHostId, meta)
}

export function updateExistingWorktreeMetaBatch(
  runtime: MetadataRuntime,
  scheduling: WriteSchedulingOperations,
  updates: readonly ExistingWorktreeMetadataUpdate[]
): string[] {
  const state = runtime.state
  const ids = new Set(updates.map((update) => update.worktreeId))
  const aliases = indexMetadataAliasesForWorktreeIds(state, ids)
  const repoHosts = new Map<string, Set<ExecutionHostId>>()
  for (const repo of state.repos) {
    const hosts = repoHosts.get(repo.id) ?? new Set<ExecutionHostId>()
    hosts.add(getRepoExecutionHostId(repo))
    repoHosts.set(repo.id, hosts)
  }
  const accepted: string[] = []
  for (const update of updates) {
    const hosts = metadataOwnerHosts(
      state,
      update.worktreeId,
      (aliases.get(update.worktreeId) ?? []).map(([alias]) => alias),
      repoHosts.get(getRepoIdFromWorktreeId(update.worktreeId)) ?? []
    )
    const target = existingMutationTarget(state, update.worktreeId, {}, hosts)
    if (!target || !metadataUpdatePreservesOccupant(target, update.updates)) {
      continue
    }
    setWorktreeMetaForHost(
      runtime,
      scheduling,
      update.worktreeId,
      target.executionHostId,
      update.updates
    )
    accepted.push(update.worktreeId)
  }
  return accepted
}

const metadataAdmissionContext = Symbol('WorktreeMetadataAdmissionOperations')
type MetadataAdmissionContext = { runtime: MetadataRuntime; scheduling: WriteSchedulingOperations }

export class WorktreeMetadataAdmissionOperations {
  readonly [metadataAdmissionContext]: MetadataAdmissionContext

  constructor(runtime: MetadataRuntime, scheduling: WriteSchedulingOperations) {
    this[metadataAdmissionContext] = { runtime, scheduling }
  }

  isCurrentWorktreeMetadata(
    worktreeId: string,
    expectation: WorktreeMetadataExpectation = {},
    updates: Partial<WorktreeMeta> = {}
  ): boolean {
    return isCurrentWorktreeMetadata(
      this[metadataAdmissionContext].runtime,
      worktreeId,
      expectation,
      updates
    )
  }

  updateExistingWorktreeMeta(
    worktreeId: string,
    updates: Partial<WorktreeMeta> & WorkspaceAttachmentMutation,
    expectation: WorktreeMetadataExpectation = {}
  ): WorktreeMeta | undefined {
    const { runtime, scheduling } = this[metadataAdmissionContext]
    return updateExistingWorktreeMeta(runtime, scheduling, worktreeId, updates, expectation)
  }

  updateExistingWorktreeMetaBatch(updates: readonly ExistingWorktreeMetadataUpdate[]): string[] {
    const { runtime, scheduling } = this[metadataAdmissionContext]
    return updateExistingWorktreeMetaBatch(runtime, scheduling, updates)
  }
}

export function installWorktreeMetadataAdmissionContext(
  target: WorktreeMetadataAdmissionOperations,
  source: WorktreeMetadataAdmissionOperations
): void {
  Object.defineProperty(target, metadataAdmissionContext, {
    value: source[metadataAdmissionContext]
  })
}
