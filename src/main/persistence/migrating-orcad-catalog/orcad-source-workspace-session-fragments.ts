import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
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

/**
 * Null when two partitions disagree about the same worktree. The same marker in both (a renderer
 * snapshot can copy one into the local and the host partition) is not a disagreement.
 */
export function mergeSessionFragments(
  fragments: WorkspaceSessionState[]
): WorkspaceSessionState | null {
  const ownerKeys = new Set<string>()
  const entityKeys = new Set<string>()
  const keyedValues = new Map<string, string>()
  let merged: WorkspaceSessionState | undefined
  for (const fragment of fragments) {
    const owners = collectSessionOwnerKeys(fragment)
    if (
      [...owners].some((key) => ownerKeys.has(key) && !agreesOnOwner(fragment, key, keyedValues)) ||
      hasDuplicates(entityKeys, collectSessionEntityKeys(fragment))
    ) {
      return null
    }
    owners.forEach((key) => ownerKeys.add(key))
    for (const field of OWNER_KEYED_FIELDS) {
      for (const [key, value] of Object.entries(fragment[field] ?? {})) {
        keyedValues.set(`${field}\0${key}`, serializeOrcadMigrationValue(value))
      }
    }
    merged = mergeWorkspaceSessions(merged, fragment)
  }
  return merged ?? null
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
