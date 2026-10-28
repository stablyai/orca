// Compare stores independently of mover export so omitted rows remain visible after host/path normalization.
import { getAutomationRunRepoId } from '../../../shared/automation-run-identity'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  normalizeWorkspaceSessionKeyToWorkspaceId,
  parseWorkspaceKey
} from '../../../shared/workspace-scope'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { getAllWorktreeMetaForHost } from '../loading-store/worktree-identity-metadata'
import { collectProjectGroups } from '../migrating-orcad-catalog/orcad-source-catalog'
import {
  canonicalizeWslMoveValue,
  createWslMoveStringNormalizer,
  isRecord
} from './wsl-move-canonical-form'
import { WSL_MOVE_DROPPED_PTY_BINDING_KEYS } from '../../../shared/wsl-move/wsl-move-dispositions'
import {
  fieldOf,
  pickKeys,
  projectWslMoveSession,
  projectWslMoveUi,
  type WslMoveOwnerInScope
} from './wsl-move-session-projection'

export type WslMoveProjectionScope = {
  distro: string
  repoIds: ReadonlySet<string>
  folderWorkspaceIds: ReadonlySet<string>
  ownerHostId: ExecutionHostId
  /** Equivalent host IDs on this side: local, runtime:wsl:<d>, wsl:<d>. */
  hostAliases: readonly string[]
}

export type WslMoveProjectionInput = {
  state: Pick<
    PersistedState,
    | 'repos'
    | 'projects'
    | 'projectGroups'
    | 'folderWorkspaces'
    | 'sparsePresetsByRepo'
    | 'retiredWorktreeNamesByRepo'
    | 'mobileClientTabSelectionsByDeviceId'
    | 'worktreeMeta'
    | 'worktreeMetaByIdentity'
    | 'worktreeIdentityAliases'
    | 'worktreeLineageById'
    | 'workspaceLineageByChildKey'
    | 'automations'
    | 'automationRuns'
  >
  session: Partial<WorkspaceSessionState>
  ui?: Partial<PersistedUIState>
}

/** Explicit projection exclusions; tests require every moved field to be compared or listed here. */
export const WSL_MOVE_PROJECTION_DEFERRED = {
  retiredWorktreeNamesByNamespace: 'D1b-3: recomputed from the Linux probe path, not mapped.',
  folderWorkspaceDiffComments:
    'Write-only copy of folderWorkspaces[].diffComments, compared there.',
  scrollbackSnapshotBytes: 'D1b-6: blob digests join the input with the chunk channel.',
  shellHistoryBlobs: 'D1b-6.',
  nativeChatJournalRecords: 'D1b-6.'
} as const

export const WSL_MOVE_PROJECTED_STATE_FIELDS = [
  'repos',
  'projects',
  'folderWorkspaces',
  'projectGroups',
  'sparsePresetsByRepo',
  'retiredWorktreeNamesByRepo',
  'mobileClientTabSelectionsByDeviceId',
  'worktreeMeta',
  'worktreeMetaByIdentity',
  'worktreeLineageById',
  'workspaceLineageByChildKey',
  'automations',
  'automationRuns'
] as const satisfies readonly (keyof PersistedState)[]

// Host bindings necessarily change during migration.
const HOST_BINDINGS = {
  repos: ['executionHostId', 'connectionId'],
  projectGroups: ['executionHostId', 'connectionId'],
  folderWorkspaces: ['executionHostId', 'connectionId'],
  projects: ['localWindowsRuntimePreference'],
  automations: [
    'executionTargetType',
    'executionTargetId',
    'executionTargetGeneration',
    'schedulerOwner'
  ],
  // Host setup IDs are re-derived; compare their resolved project IDs.
  worktreeMeta: ['projectHostSetupId']
} as const

const DROPPED_KEYS: ReadonlySet<string> = new Set(WSL_MOVE_DROPPED_PTY_BINDING_KEYS)

export function projectWslMoveState(
  input: WslMoveProjectionInput,
  scope: WslMoveProjectionScope
): unknown {
  const aliases = new Set(scope.hostAliases)
  const ownerInScope: WslMoveOwnerInScope = (owner) => {
    if (!owner) {
      return false
    }
    if (isWorktreeHostIdentity(owner)) {
      const host = getExecutionHostIdFromWorktreeHostIdentity(owner)
      if (!host || !aliases.has(host)) {
        return false
      }
    }
    const parsed = parseWorkspaceKey(owner)
    if (parsed?.type === 'folder') {
      return scope.folderWorkspaceIds.has(parsed.folderWorkspaceId)
    }
    const id = normalizeWorkspaceSessionKeyToWorkspaceId(owner)
    return scope.folderWorkspaceIds.has(id) || scope.repoIds.has(getRepoIdFromWorktreeId(id))
  }
  const { state } = input
  const repos = state.repos.filter(
    (repo) => scope.repoIds.has(repo.id) && aliases.has(getRepoExecutionHostId(repo))
  )
  const folderWorkspaces = state.folderWorkspaces.filter((workspace) =>
    scope.folderWorkspaceIds.has(workspace.id)
  )
  const automations = state.automations.filter((automation) =>
    scope.repoIds.has(getAutomationRunRepoId(automation))
  )
  const automationIds = new Set(automations.map((automation) => automation.id))
  const groupIds = new Set(
    [...repos, ...folderWorkspaces].flatMap((row) =>
      row.projectGroupId ? [row.projectGroupId] : []
    )
  )
  // Match reader precedence: identity metadata outranks legacy rows.
  const worktreeMeta = pickKeys(
    getAllWorktreeMetaForHost({ state }, scope.ownerHostId),
    ownerInScope
  )
  const projection = {
    repos: byId(withoutKeys(repos, HOST_BINDINGS.repos)),
    projects: byId(
      withoutKeys(
        state.projects.flatMap((project) => {
          // Compare only moved members; Windows siblings stay on the desktop.
          const sourceRepoIds = project.sourceRepoIds.filter((repoId) => scope.repoIds.has(repoId))
          return sourceRepoIds.length > 0 ? [{ ...project, sourceRepoIds }] : []
        }),
        HOST_BINDINGS.projects
      )
    ),
    folderWorkspaces: byId(withoutKeys(folderWorkspaces, HOST_BINDINGS.folderWorkspaces)),
    projectGroups: byId(
      withoutKeys(collectProjectGroups(state.projectGroups, groupIds), HOST_BINDINGS.projectGroups)
    ),
    sparsePresetsByRepo: pickKeys(state.sparsePresetsByRepo, (key) => scope.repoIds.has(key)),
    retiredWorktreeNamesByRepo: pickKeys(state.retiredWorktreeNamesByRepo ?? {}, (key) =>
      scope.repoIds.has(key)
    ),
    mobileClientTabSelectionsByDeviceId: Object.fromEntries(
      Object.entries(state.mobileClientTabSelectionsByDeviceId ?? {}).flatMap(
        ([device, byOwner]) => {
          const owned = pickKeys(byOwner, ownerInScope)
          return Object.keys(owned).length > 0 ? [[device, owned]] : []
        }
      )
    ),
    worktreeMeta: Object.fromEntries(
      Object.entries(worktreeMeta).map(([id, meta]) => [
        id,
        withoutKeys([meta], HOST_BINDINGS.worktreeMeta)[0]
      ])
    ),
    worktreeLineageById: pickKeys(state.worktreeLineageById, ownerInScope),
    workspaceLineageByChildKey: pickKeys(state.workspaceLineageByChildKey, ownerInScope),
    automations: byId(withoutKeys(automations, HOST_BINDINGS.automations).map(withoutSetupId)),
    automationRuns: byId(
      state.automationRuns.filter((run) => automationIds.has(run.automationId)).map(withoutSetupId)
    ),
    session: projectWslMoveSession(withoutOwnerFileBindings(input.session, aliases), ownerInScope),
    ui: projectWslMoveUi(
      input.ui ?? {},
      input.session,
      ownerInScope,
      (repoId, hostId) =>
        typeof repoId === 'string' &&
        scope.repoIds.has(repoId) &&
        (hostId === undefined || (typeof hostId === 'string' && aliases.has(hostId)))
    )
  }
  const canonical = canonicalizeWslMoveValue(
    projection,
    createWslMoveStringNormalizer(scope),
    DROPPED_KEYS
  )
  dropSelfPriorIds(canonical)
  return canonical
}

/** A file bound to its owning host is that host's file whether or not the binding is written. */
function withoutOwnerFileBindings<T extends Partial<WorkspaceSessionState>>(
  session: T,
  aliases: ReadonlySet<string>
): T {
  if (!session.openFilesByWorktree) {
    return session
  }
  return {
    ...session,
    openFilesByWorktree: Object.fromEntries(
      Object.entries(session.openFilesByWorktree).map(([owner, files]) => [
        owner,
        files.map(({ runtimeEnvironmentId, ...file }) =>
          runtimeEnvironmentId === undefined ||
          runtimeEnvironmentId === null ||
          aliases.has(runtimeEnvironmentId)
            ? file
            : { ...file, runtimeEnvironmentId }
        )
      ])
    )
  }
}

/** Catalog order is immaterial and may change on import. */
function byId<T extends { id: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

function withoutKeys<T extends object>(rows: readonly T[], keys: readonly string[]): T[] {
  return rows.map((row) => {
    const copy = { ...row }
    for (const key of keys) {
      Reflect.deleteProperty(copy, key)
    }
    return copy
  })
}

// Run-context setup IDs are re-derived on the destination.
function withoutSetupId<T extends { runContext?: object | null }>(row: T): T {
  if (!row.runContext) {
    return row
  }
  const runContext = { ...row.runContext }
  Reflect.deleteProperty(runContext, 'projectHostSetupId')
  return { ...row, runContext }
}

// Drop canonical self-aliases; findMissingWslMoveAliases separately verifies UNC alias retention.
function dropSelfPriorIds(canonical: unknown): void {
  const meta = fieldOf(canonical, 'worktreeMeta')
  if (!isRecord(meta)) {
    return
  }
  for (const [worktreeId, row] of Object.entries(meta)) {
    const prior = fieldOf(row, 'priorWorktreeIds')
    if (isRecord(row) && Array.isArray(prior)) {
      const kept = prior.filter((id) => id !== worktreeId)
      if (kept.length > 0) {
        row.priorWorktreeIds = kept
      } else {
        delete row.priorWorktreeIds
      }
    }
  }
}
