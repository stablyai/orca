import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration/orcad-migration-manifest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { mergeWorkspaceSessions } from '../../orca-profiles/profile-project-session-state'
import { SESSION_FIELDS_PRUNED_BY_OWNER_KEY } from '../../orca-profiles/profile-project-session-field-disposition'
import { withRequiredWorkspaceSessionMaps } from '../loading-store/session-host-partitions'

export function sessionPartitions(
  state: {
    workspaceSession: WorkspaceSessionState
    workspaceSessionsByHostId?: Record<string, WorkspaceSessionState | undefined>
  },
  localHostId: string
): [string, WorkspaceSessionState][] {
  return [
    [localHostId, withRequiredWorkspaceSessionMaps(state.workspaceSession)],
    ...Object.entries(state.workspaceSessionsByHostId ?? {}).flatMap(
      ([hostId, session]): [string, WorkspaceSessionState][] =>
        // A partition written before its maps were filled in on write still loads without them.
        session ? [[hostId, withRequiredWorkspaceSessionMaps(session)]] : []
    )
  ]
}

export type MergedSessionFragments = {
  session: WorkspaceSessionState | null
  /** Worktrees two partitions saved differently, when `session` is null. */
  conflicts: string[]
}

/**
 * Null when two partitions disagree about the same worktree. The same marker in both (a renderer
 * snapshot can copy one into the local and the host partition) is not a disagreement, and neither
 * is an empty row beside a populated one: like the app's own adoption, empty is not evidence.
 */
export function mergeSessionFragments(
  fragments: WorkspaceSessionState[],
  /** Tabs some partition recorded as closed: a row listing one never wins over an empty row. */
  closedTabIds: ReadonlySet<string>
): MergedSessionFragments {
  const ownerKeys = new Set<string>()
  const entityKeys = new Set<string>()
  const keyedValues = new Map<string, string>()
  let merged: WorkspaceSessionState | undefined
  const populated = populatedOwnerRows(fragments, closedTabIds)
  for (const fragment of fragments.map((entry) =>
    withoutEmptyRowsFilledElsewhere(entry, populated)
  )) {
    const owners = collectSessionOwnerKeys(fragment)
    const conflicts = [...owners].filter(
      (key) => ownerKeys.has(key) && !agreesOnOwner(fragment, key, keyedValues)
    )
    if (conflicts.length > 0) {
      return { session: null, conflicts }
    }
    if (hasDuplicates(entityKeys, collectSessionEntityKeys(fragment))) {
      return { session: null, conflicts: [...owners] }
    }
    owners.forEach((key) => ownerKeys.add(key))
    for (const field of OWNER_KEYED_FIELDS) {
      for (const [key, value] of Object.entries(fragment[field] ?? {})) {
        keyedValues.set(`${field}\0${key}`, serializeOrcadMigrationValue(value))
      }
    }
    merged = mergeWorkspaceSessions(merged, fragment)
  }
  return merged ? { session: merged, conflicts: [] } : { session: null, conflicts: [] }
}

/** Field and owner key of every populated row, except a tab row naming a closed tab. */
function populatedOwnerRows(
  fragments: readonly WorkspaceSessionState[],
  closedTabIds: ReadonlySet<string>
): Set<string> {
  const populated = new Set<string>()
  for (const fragment of fragments) {
    for (const field of OWNER_KEYED_FIELDS) {
      for (const [key, value] of Object.entries(fragment[field] ?? {})) {
        const reopensClosedTab =
          field === 'tabsByWorktree' &&
          (fragment.tabsByWorktree[key] ?? []).some((tab) => closedTabIds.has(tab.id))
        if (!isEmptyRow(value) && !reopensClosedTab) {
          populated.add(`${field}\0${key}`)
        }
      }
    }
  }
  return populated
}

function withoutEmptyRowsFilledElsewhere(
  fragment: WorkspaceSessionState,
  populated: ReadonlySet<string>
): WorkspaceSessionState {
  let next: WorkspaceSessionState | undefined
  for (const field of OWNER_KEYED_FIELDS) {
    for (const [key, value] of Object.entries(fragment[field] ?? {})) {
      if (isEmptyRow(value) && populated.has(`${field}\0${key}`)) {
        next ??= structuredClone(fragment)
        const rows: unknown = next[field]
        if (rows && typeof rows === 'object') {
          Reflect.deleteProperty(rows, key)
        }
      }
    }
  }
  return next ?? fragment
}

function isEmptyRow(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true
  }
  if (Array.isArray(value)) {
    return value.length === 0
  }
  return typeof value === 'object' && Object.keys(value).length === 0
}

const OWNER_KEYED_FIELDS = [
  'tabsByWorktree',
  'openFilesByWorktree',
  'browserTabsByWorktree',
  'unifiedTabs',
  'tabGroups',
  ...SESSION_FIELDS_PRUNED_BY_OWNER_KEY
] as const

function agreesOnOwner(
  fragment: WorkspaceSessionState,
  ownerKey: string,
  keyedValues: ReadonlyMap<string, string>
): boolean {
  return OWNER_KEYED_FIELDS.every((field) => {
    // A fence, not a choice: mergeWorkspaceSessions keeps the highest revision.
    if (field === 'terminalTopologyRevisionByRepoId') {
      return true
    }
    const value: unknown = Object.getOwnPropertyDescriptor(fragment[field] ?? {}, ownerKey)?.value
    const seen = keyedValues.get(`${field}\0${ownerKey}`)
    return value === undefined || seen === undefined || seen === serializeOrcadMigrationValue(value)
  })
}

export function collectSessionOwnerKeys(session: WorkspaceSessionState): Set<string> {
  const keys = new Set<string>()
  for (const field of OWNER_KEYED_FIELDS) {
    Object.keys(session[field] ?? {}).forEach((key) => keys.add(key))
  }
  Object.values(session.tabsByWorktree ?? {})
    .flat()
    .forEach((entry) => keys.add(entry.worktreeId))
  Object.values(session.openFilesByWorktree ?? {})
    .flat()
    .forEach((entry) => keys.add(entry.worktreeId))
  Object.values(session.browserTabsByWorktree ?? {})
    .flat()
    .forEach((entry) => keys.add(entry.worktreeId))
  Object.values(session.browserPagesByWorkspace ?? {})
    .flat()
    .forEach((entry) => keys.add(entry.worktreeId))
  Object.values(session.unifiedTabs ?? {})
    .flat()
    .forEach((entry) => keys.add(entry.worktreeId))
  Object.values(session.tabGroups ?? {})
    .flat()
    .forEach((entry) => keys.add(entry.worktreeId))
  Object.values(session.terminalSurfaceTombstonesByPaneKey ?? {}).forEach((entry) =>
    keys.add(entry.worktreeId)
  )
  Object.values(session.sleepingAgentSessionsByPaneKey ?? {}).forEach((entry) =>
    keys.add(entry.worktreeId)
  )
  return keys
}

export function collectSessionEntityKeys(session: WorkspaceSessionState): string[] {
  const keys: string[] = []
  Object.values(session.tabsByWorktree ?? {})
    .flat()
    .forEach((tab) => keys.push(`terminal:${tab.id}`))
  Object.values(session.browserTabsByWorktree ?? {})
    .flat()
    .forEach((tab) => keys.push(`browser:${tab.id}`))
  Object.values(session.clientHostedBrowserPagesByWorktree ?? {})
    .flat()
    .forEach((page) => keys.push(`client-browser-page:${page.browserPageId}`))
  Object.values(session.unifiedTabs ?? {})
    .flat()
    .forEach((tab) => keys.push(`tab:${tab.id}`))
  Object.values(session.tabGroups ?? {})
    .flat()
    .forEach((group) => keys.push(`group:${group.id}`))
  Object.keys(session.terminalSurfaceTombstonesByPaneKey ?? {}).forEach((key) =>
    keys.push(`tombstone:${key}`)
  )
  Object.keys(session.sleepingAgentSessionsByPaneKey ?? {}).forEach((key) =>
    keys.push(`sleeping-agent:${key}`)
  )
  return keys
}

function hasDuplicates(seen: Set<string>, incoming: Iterable<string>): boolean {
  let duplicate = false
  for (const key of incoming) {
    if (seen.has(key)) {
      duplicate = true
    }
    seen.add(key)
  }
  return duplicate
}
