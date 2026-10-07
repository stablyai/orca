/**
 * Client state that still references an SSH target. An empty-host claim refuses any of it, since
 * hiding the target would strand it; a migration blocks only on what its manifest can't carry.
 */
import type { Store } from '../persistence'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { GLOBAL_WORKSPACE_SESSION_FIELDS } from '../../shared/workspace-session-host-field-ownership'
import {
  ORCAD_MIGRATION_DEPENDENCY_KINDS,
  type OrcadMigrationBlocker,
  type OrcadMigrationDependency,
  type OrcadMigrationDependencyKind
} from '../../shared/orcad-migration-preflight'
import type { OrcadMigrationManifest } from '../../shared/orcad-migration-manifest'

export type DependentStateStore = Pick<
  Store,
  | 'getAllWorktreeMetaForHost'
  | 'getSshRemotePtyLeases'
  | 'getWorkspaceSession'
  | 'getWorkspaceSessionHostIds'
  | 'listAutomations'
>

const MAX_NAMES = 5

export function collectDependentStateBlockers(
  store: DependentStateStore,
  targetId: string
): OrcadMigrationBlocker[] {
  const hostId = toSshExecutionHostId(targetId)
  const readers: [OrcadMigrationDependencyKind, () => string[]][] = [
    ['workspace-session', () => workspaceSessionReferences(store, hostId)],
    [
      'automation',
      () =>
        store
          .listAutomations()
          .filter((a) => a.executionTargetType === 'ssh' && a.executionTargetId === targetId)
          .map((a) => a.name)
    ],
    ['worktree-metadata', () => Object.keys(store.getAllWorktreeMetaForHost(hostId))],
    // Why every status: a terminated lease is still a saved record pointing at this host.
    [
      'terminal-lease',
      () => store.getSshRemotePtyLeases(targetId).map((lease) => `${lease.ptyId} (${lease.state})`)
    ]
  ]
  const dependencies: OrcadMigrationDependency[] = []
  const unreadable: OrcadMigrationDependencyKind[] = []
  for (const [kind, read] of readers) {
    let names: string[]
    try {
      names = read()
    } catch {
      unreadable.push(kind)
      continue
    }
    if (names.length > 0) {
      dependencies.push({ kind, count: names.length, names: names.slice(0, MAX_NAMES) })
    }
  }
  const blockers: OrcadMigrationBlocker[] = []
  if (dependencies.length > 0) {
    blockers.push({
      code: 'orcad_migration_dependent_state',
      category: 'client-owned-state',
      dependencies
    })
  }
  if (unreadable.length > 0) {
    blockers.push({
      code: 'orcad_migration_dependency_unverifiable',
      category: 'live-or-unverifiable',
      sources: unreadable
    })
  }
  return blockers
}

/** Kinds with their own blockers (port forwards, terminal leases) are counted elsewhere. */
const CENSUS_DEPENDENCY_KINDS = ORCAD_MIGRATION_DEPENDENCY_KINDS.filter(
  (kind) => kind !== 'saved-port-forward' && kind !== 'terminal-lease'
)

/**
 * The export-aware census: only state that references the target and that this manifest cannot
 * carry blocks. A census the store could not take is unverifiable, never an empty one.
 */
export function collectUntransferredDependentBlockers(
  store: Pick<Store, 'inspectOrcadMigrationUntransferredDependencies'>,
  manifest: OrcadMigrationManifest
): OrcadMigrationBlocker[] {
  let counts: Record<OrcadMigrationDependencyKind, number>
  try {
    counts = store.inspectOrcadMigrationUntransferredDependencies(manifest).counts
  } catch {
    return [
      {
        code: 'orcad_migration_dependency_unverifiable',
        category: 'live-or-unverifiable',
        sources: [...CENSUS_DEPENDENCY_KINDS]
      }
    ]
  }
  const dependencies = CENSUS_DEPENDENCY_KINDS.filter((kind) => counts[kind] > 0).map((kind) => ({
    kind,
    count: counts[kind]
  }))
  return dependencies.length > 0
    ? [{ code: 'orcad_migration_dependent_state', category: 'client-owned-state', dependencies }]
    : []
}

/** Non-default host-owned fields of the host's partition, plus a local session pointed at the host. */
function workspaceSessionReferences(store: DependentStateStore, hostId: string): string[] {
  const references: string[] = []
  if (store.getWorkspaceSession().activeWorkspaceExecutionHostId === hostId) {
    references.push('active workspace')
  }
  if (!store.getWorkspaceSessionHostIds().some((id) => id === hostId)) {
    return references
  }
  const defaults: Record<string, unknown> = { ...getDefaultWorkspaceSession() }
  // A partition's global fields are copies of client-wide focus and history, not host state.
  const globalFields = new Set<string>(GLOBAL_WORKSPACE_SESSION_FIELDS)
  for (const [field, value] of Object.entries(store.getWorkspaceSession(hostId))) {
    if (globalFields.has(field)) {
      continue
    }
    if (!isEmptyValue(value) && JSON.stringify(value) !== JSON.stringify(defaults[field])) {
      references.push(field)
    }
  }
  return references
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true
  }
  if (Array.isArray(value)) {
    return value.length === 0
  }
  return typeof value === 'object' && Object.keys(value).length === 0
}

export function dependentStateMessage(dependencies: OrcadMigrationDependency[]): string {
  const parts = dependencies.map(
    ({ kind, count, names }) => `${kind} ×${count}${names?.length ? ` (${names.join(', ')})` : ''}`
  )
  return (
    'This SSH target is still referenced by saved Orca state that a managed server cannot take ' +
    `over yet: ${parts.join('; ')}. Remove it, or keep this host in direct SSH mode.`
  )
}
