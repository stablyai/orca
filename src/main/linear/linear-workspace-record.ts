import type { LinearWorkspace, LinearWorkspaceSelection } from '../../shared/linear/workspace-types'

export type LinearWorkspaceFile = {
  version: 1
  activeWorkspaceId: string | null
  selectedWorkspaceId: LinearWorkspaceSelection | null
  workspaces: LinearWorkspace[]
}

export function normalizeWorkspace(input: unknown): LinearWorkspace | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.organizationName !== 'string') {
    return null
  }
  if (typeof record.displayName !== 'string') {
    return null
  }

  const organizationId =
    typeof record.organizationId === 'string' && record.organizationId
      ? record.organizationId
      : record.id

  return {
    id: record.id,
    organizationId,
    organizationName: record.organizationName,
    organizationUrlKey:
      typeof record.organizationUrlKey === 'string' ? record.organizationUrlKey : undefined,
    displayName: record.displayName,
    email: typeof record.email === 'string' ? record.email : null,
    credentialRevision:
      typeof record.credentialRevision === 'number' && Number.isFinite(record.credentialRevision)
        ? record.credentialRevision
        : undefined
  }
}

export function emptyWorkspaceFile(): LinearWorkspaceFile {
  return {
    version: 1,
    activeWorkspaceId: null,
    selectedWorkspaceId: null,
    workspaces: []
  }
}

export function workspaceFromLinearData(
  me: { displayName: string; email?: string | null },
  org: { id: string; name: string; urlKey?: string | null }
): LinearWorkspace {
  return {
    id: org.id,
    organizationId: org.id,
    organizationName: org.name,
    organizationUrlKey: org.urlKey ?? undefined,
    displayName: me.displayName,
    email: me.email ?? null
  }
}
