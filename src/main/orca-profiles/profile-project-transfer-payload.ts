import {
  extractProjectColdEvidence,
  mergeProjectColdEvidence
} from './profile-project-cold-evidence'
import { randomUUID } from 'node:crypto'
import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import type { SshTarget } from '../../shared/ssh-types'
import type { WorkspaceKey } from '../../shared/folder-workspace-types'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { Repo } from '../../shared/repo-types'
import type { SparsePreset } from '../../shared/worktree/create-types'
import type { RetiredNameRegistry } from '../../shared/worktree/retired-name-registry'
import {
  extractRetiredNameRegistriesByNamespace,
  mergeRetiredNameRegistryMaps
} from './profile-project-retired-name-transfer'
import type { TransferProfileState } from './profile-project-state-file'
import { rebuildRepoBackedProjectState } from './profile-project-state-file'
import { mergeHostWorkspaceSessions, mergeWorkspaceSessions } from './profile-project-session-state'
import {
  extractHostSessionsForTransfer,
  extractSessionForTransfer
} from './profile-project-session-transfer'
import { collectTransferWorktreeIds } from './profile-project-transfer-worktree-ids'
import { rekeyWorktreeId, rekeyWorkspaceKey } from './profile-project-worktree-identity'
import { extractProjectSurfaces, mergeProjectSurfaces } from './profile-project-surface-transfer'
import { remapProjectSurfacePresentation } from './profile-project-surface-presentation'

export type TransferPayload = {
  repo: Repo
  sparsePresets: SparsePreset[]
  /** Preserve spent names so the destination cannot reuse directories still holding agent state. */
  retiredNameRegistry: RetiredNameRegistry | undefined
  retiredNameRegistriesByNamespace: Record<string, RetiredNameRegistry>
  worktreeMeta: PersistedState['worktreeMeta']
  worktreeLineageById: PersistedState['worktreeLineageById']
  workspaceLineageByChildKey: PersistedState['workspaceLineageByChildKey']
  workspaceSession?: PersistedState['workspaceSession']
  workspaceSessionsByHostId?: Partial<Record<ExecutionHostId, PersistedState['workspaceSession']>>
  workspaceSurfaces?: PersistedState['workspaceSurfaces']
  surfaceEvidence?: Record<string, unknown>
  sshTargets: SshTarget[]
  targetProjectId: string | null
}

export function createTargetRepo(
  sourceRepo: Repo,
  targetState: TransferProfileState,
  copy: boolean
): Repo {
  const targetRepoId =
    !copy && !targetState.repos.some((repo) => repo.id === sourceRepo.id)
      ? sourceRepo.id
      : createUniqueRepoId(targetState)
  const repo: Repo = {
    ...sourceRepo,
    id: targetRepoId,
    projectGroupId: null,
    addedAt: copy ? Date.now() : sourceRepo.addedAt
  }
  delete repo.projectGroupOrder
  return repo
}

function createUniqueRepoId(state: TransferProfileState): string {
  const existingRepoIds = new Set(state.repos.map((repo) => repo.id))
  let candidate = randomUUID()
  while (existingRepoIds.has(candidate)) {
    candidate = randomUUID()
  }
  return candidate
}

function rekeyWorktreeIdRecord<T>(
  record: Record<string, T>,
  worktreeIds: ReadonlySet<string>,
  oldRepoId: string,
  newRepoId: string,
  mapValue: (value: T) => T = (value) => structuredClone(value)
): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [oldKey, value] of Object.entries(record)) {
    if (worktreeIds.has(oldKey)) {
      next[rekeyWorktreeId(oldRepoId, newRepoId, oldKey)] = mapValue(value)
    }
  }
  return next
}

function rekeyLineageRecord(
  record: PersistedState['worktreeLineageById'],
  worktreeIds: ReadonlySet<string>,
  oldRepoId: string,
  newRepoId: string
): PersistedState['worktreeLineageById'] {
  const next: PersistedState['worktreeLineageById'] = {}
  for (const [oldKey, lineage] of Object.entries(record)) {
    if (!worktreeIds.has(oldKey) && !worktreeIds.has(lineage.parentWorktreeId)) {
      continue
    }
    const newKey = rekeyWorktreeId(oldRepoId, newRepoId, oldKey)
    next[newKey] = {
      ...structuredClone(lineage),
      worktreeId: rekeyWorktreeId(oldRepoId, newRepoId, lineage.worktreeId),
      parentWorktreeId: rekeyWorktreeId(oldRepoId, newRepoId, lineage.parentWorktreeId)
    }
  }
  return next
}

function rekeyWorkspaceLineageRecord(
  record: PersistedState['workspaceLineageByChildKey'],
  oldRepoId: string,
  newRepoId: string
): PersistedState['workspaceLineageByChildKey'] {
  const next: PersistedState['workspaceLineageByChildKey'] = {}
  for (const [oldKey, lineage] of Object.entries(record)) {
    const newChildKey = rekeyWorkspaceKey(oldRepoId, newRepoId, oldKey as WorkspaceKey)
    const newParentKey = rekeyWorkspaceKey(oldRepoId, newRepoId, lineage.parentWorkspaceKey)
    if (newChildKey === oldKey && newParentKey === lineage.parentWorkspaceKey) {
      continue
    }
    next[newChildKey] = {
      ...structuredClone(lineage),
      childWorkspaceKey: newChildKey,
      parentWorkspaceKey: newParentKey
    }
  }
  return next
}

export function createTransferPayload(args: {
  sourceState: TransferProfileState
  sourceRepo: Repo
  targetRepo: Repo
  includeSessions: boolean
}): TransferPayload {
  const { sourceState, sourceRepo, targetRepo, includeSessions } = args
  const oldRepoId = sourceRepo.id
  const newRepoId = targetRepo.id
  const worktreeIds = collectTransferWorktreeIds(sourceState, oldRepoId)
  const targetProjection = projectHostSetupProjectionFromRepos([targetRepo])
  const targetProjectId =
    targetProjection.setups[0]?.projectId ?? targetProjection.projects[0]?.id ?? null
  return {
    repo: targetRepo,
    sparsePresets: (sourceState.sparsePresetsByRepo[oldRepoId] ?? []).map((preset) => ({
      ...structuredClone(preset),
      repoId: newRepoId
    })),
    retiredNameRegistry: sourceState.retiredWorktreeNamesByRepo?.[oldRepoId],
    retiredNameRegistriesByNamespace: extractRetiredNameRegistriesByNamespace(
      sourceState,
      sourceRepo
    ),
    worktreeMeta: rekeyWorktreeIdRecord(
      sourceState.worktreeMeta,
      worktreeIds,
      oldRepoId,
      newRepoId,
      (meta) => ({
        ...structuredClone(meta),
        ...(targetProjectId ? { projectId: targetProjectId } : {}),
        hostId: getRepoExecutionHostId(targetRepo),
        projectHostSetupId: targetRepo.id
      })
    ),
    worktreeLineageById: rekeyLineageRecord(
      sourceState.worktreeLineageById,
      worktreeIds,
      oldRepoId,
      newRepoId
    ),
    workspaceLineageByChildKey: rekeyWorkspaceLineageRecord(
      sourceState.workspaceLineageByChildKey,
      oldRepoId,
      newRepoId
    ),
    ...(includeSessions
      ? {
          surfaceEvidence: extractProjectColdEvidence(sourceState, oldRepoId, newRepoId),
          workspaceSurfaces: extractProjectSurfaces(
            sourceState.workspaceSurfaces,
            oldRepoId,
            newRepoId
          ),
          workspaceSession: extractSessionForTransfer(
            sourceState.workspaceSession,
            oldRepoId,
            newRepoId
          ),
          workspaceSessionsByHostId: extractHostSessionsForTransfer(
            sourceState.workspaceSessionsByHostId,
            oldRepoId,
            newRepoId
          )
        }
      : {}),
    sshTargets: sourceRepo.connectionId
      ? sourceState.sshTargets.filter((target) => target.id === sourceRepo.connectionId)
      : [],
    targetProjectId
  }
}

export function applyPayloadToTarget(
  targetState: TransferProfileState,
  payload: TransferPayload
): TransferProfileState {
  const surfaceEvidence = mergeProjectColdEvidence(targetState, payload.surfaceEvidence ?? {})
  const canonical =
    payload.workspaceSurfaces &&
    mergeProjectSurfaces(
      targetState.workspaceSurfaces,
      payload.workspaceSurfaces,
      (hostId) =>
        Object.values(
          (hostId === 'local'
            ? targetState.workspaceSession
            : targetState.workspaceSessionsByHostId?.[requireSurfaceHostId(hostId)]
          )?.unifiedTabs ?? {}
        ).flatMap((tabs) => tabs.map((tab) => tab.id)),
      { ...targetState, ...surfaceEvidence }
    )
  const incoming = (hostId: ExecutionHostId, session: PersistedState['workspaceSession']) =>
    canonical
      ? remapProjectSurfacePresentation(session, hostId, canonical.identities.get(hostId) ?? [])
      : session
  const next: TransferProfileState = {
    ...targetState,
    ...surfaceEvidence,
    ...(canonical ? { workspaceSurfaces: canonical.domain } : {}),
    repos: [...targetState.repos, payload.repo],
    sparsePresetsByRepo: {
      ...targetState.sparsePresetsByRepo,
      ...(payload.sparsePresets.length > 0 ? { [payload.repo.id]: payload.sparsePresets } : {})
    },
    retiredWorktreeNamesByRepo: {
      ...targetState.retiredWorktreeNamesByRepo,
      ...(payload.retiredNameRegistry ? { [payload.repo.id]: payload.retiredNameRegistry } : {})
    },
    retiredWorktreeNamesByNamespace: mergeRetiredNameRegistryMaps(
      targetState.retiredWorktreeNamesByNamespace ?? {},
      payload.retiredNameRegistriesByNamespace
    ),

    worktreeMeta: { ...targetState.worktreeMeta, ...payload.worktreeMeta },
    worktreeLineageById: { ...targetState.worktreeLineageById, ...payload.worktreeLineageById },
    workspaceLineageByChildKey: {
      ...targetState.workspaceLineageByChildKey,
      ...payload.workspaceLineageByChildKey
    },
    sshTargets: mergeSshTargets(targetState.sshTargets, payload.sshTargets)
  }
  if (payload.workspaceSession) {
    next.workspaceSession = mergeWorkspaceSessions(
      targetState.workspaceSession,
      incoming('local', payload.workspaceSession)
    )
  }
  if (payload.workspaceSessionsByHostId) {
    next.workspaceSessionsByHostId = mergeHostWorkspaceSessions(
      targetState.workspaceSessionsByHostId,
      Object.fromEntries(
        Object.entries(payload.workspaceSessionsByHostId).flatMap(([hostId, session]) =>
          session ? [[hostId, incoming(requireSurfaceHostId(hostId), session)]] : []
        )
      )
    )
  }
  return rebuildRepoBackedProjectState(next)
}

function mergeSshTargets(existing: SshTarget[], incoming: SshTarget[]): SshTarget[] {
  const existingIds = new Set(existing.map((target) => target.id))
  return [...existing, ...incoming.filter((target) => !existingIds.has(target.id))]
}

function requireSurfaceHostId(value: string): ExecutionHostId {
  const hostId = normalizeExecutionHostId(value)
  if (!hostId) {
    throw new Error('Profile surface host identity is invalid')
  }
  return hostId
}
