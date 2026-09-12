import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { mergeWorkspaceSessions } from '../../orca-profiles/profile-project-session-state'
import { SESSION_FIELDS_PRUNED_BY_OWNER_KEY } from '../../orca-profiles/profile-project-session-field-disposition'

export function sessionPartitions(
  state: {
    workspaceSession: WorkspaceSessionState
    workspaceSessionsByHostId?: Record<string, WorkspaceSessionState | undefined>
  },
  localHostId: string
): [string, WorkspaceSessionState][] {
  return [
    [localHostId, state.workspaceSession],
    ...Object.entries(state.workspaceSessionsByHostId ?? {}).flatMap(([hostId, session]) =>
      session ? [[hostId, session] as [string, WorkspaceSessionState]] : []
    )
  ]
}

export function mergeSessionFragments(
  fragments: WorkspaceSessionState[]
): WorkspaceSessionState | null {
  const ownerKeys = new Set<string>()
  const entityKeys = new Set<string>()
  let merged: WorkspaceSessionState | undefined
  for (const fragment of fragments) {
    if (
      hasDuplicates(ownerKeys, collectSessionOwnerKeys(fragment)) ||
      hasDuplicates(entityKeys, collectSessionEntityKeys(fragment))
    ) {
      return null
    }
    merged = mergeWorkspaceSessions(merged, fragment)
  }
  return merged ?? null
}

export function collectSessionOwnerKeys(session: WorkspaceSessionState): Set<string> {
  const keys = new Set<string>()
  const fields = [
    'tabsByWorktree',
    'openFilesByWorktree',
    'browserTabsByWorktree',
    'unifiedTabs',
    'tabGroups',
    ...SESSION_FIELDS_PRUNED_BY_OWNER_KEY
  ] as const
  for (const field of fields) {
    Object.keys((session[field] as Record<string, unknown> | undefined) ?? {}).forEach((key) =>
      keys.add(key)
    )
  }
  Object.values(session.tabsByWorktree)
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
  Object.values(session.tabsByWorktree)
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
