/**
 * Client state that still references an SSH target. Until the full migration census exists,
 * any of it keeps the host from being claimed: hiding the target would strand that state.
 */
import type { Store } from '../persistence'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { toSshExecutionHostId } from '../../shared/execution-host'
import type {
  OrcadMigrationBlocker,
  OrcadMigrationDependency,
  OrcadMigrationDependencyKind
} from '../../shared/orcad-migration-preflight'

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

/** Non-default fields of the host's session partition, plus a local session pointed at the host. */
function workspaceSessionReferences(store: DependentStateStore, hostId: string): string[] {
  const references: string[] = []
  if (store.getWorkspaceSession().activeWorkspaceExecutionHostId === hostId) {
    references.push('active workspace')
  }
  if (!store.getWorkspaceSessionHostIds().some((id) => id === hostId)) {
    return references
  }
  const defaults: Record<string, unknown> = { ...getDefaultWorkspaceSession() }
  for (const [field, value] of Object.entries(store.getWorkspaceSession(hostId))) {
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
