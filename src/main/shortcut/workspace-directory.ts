import type {
  ShortcutMember,
  ShortcutTeam,
  ShortcutWorkflow,
  ShortcutWorkspaceSelection
} from '../../shared/shortcut-types'
import { clearToken, getClients, isAuthError } from './client'
import { getWorkspaceMetadata } from './workspace-metadata'

// Workspace directory reads (teams, workflows, members) that back the create
// dialog and the owner/state pickers. All come from the metadata cache, so
// they cost nothing after the first story read.

export async function listTeams(
  workspaceId?: ShortcutWorkspaceSelection | null
): Promise<ShortcutTeam[]> {
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return []
  }
  const surfaceFailure = workspaceId !== 'all' && entries.length <= 1
  const results = await Promise.all(
    entries.map(async (entry) => {
      try {
        const metadata = await getWorkspaceMetadata(entry)
        return [...metadata.teamsById.values()].map((team) => ({
          ...team,
          workspaceId: entry.workspace.id,
          workspaceName: entry.workspace.name
        }))
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
          if (surfaceFailure) {
            throw error
          }
        } else {
          console.warn('[shortcut] listTeams failed:', error)
        }
        return []
      }
    })
  )
  return results.flat().sort((a, b) => a.name.localeCompare(b.name))
}

export async function listWorkflows(workspaceId?: string | null): Promise<ShortcutWorkflow[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }
  try {
    const metadata = await getWorkspaceMetadata(entry)
    return metadata.workflows
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    console.warn('[shortcut] listWorkflows failed:', error)
    return []
  }
}

export async function listMembers(workspaceId?: string | null): Promise<ShortcutMember[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }
  try {
    const metadata = await getWorkspaceMetadata(entry)
    return metadata.activeMembers
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    console.warn('[shortcut] listMembers failed:', error)
    return []
  }
}
