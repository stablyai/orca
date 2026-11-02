import type { PlaneProject, PlaneState } from '../../shared/plane-types'
import { planeRequest } from './authenticated-request'
import { getClient } from './client'
import {
  normalizeStateGroup,
  type RawPlaneProject,
  type RawPlaneState
} from './plane-issue-mappers'

export async function listProjects(workspaceSlug?: string): Promise<PlaneProject[]> {
  const client = getClient()
  if (!client) {
    return []
  }
  const slug = workspaceSlug || client.activeWorkspaceSlug
  if (!slug) {
    return []
  }

  try {
    const raw = await planeRequest<RawPlaneProject[] | { results?: RawPlaneProject[] }>(
      client.instanceUrl,
      client.apiToken,
      `/api/v1/workspaces/${slug}/projects/`
    )
    const list = Array.isArray(raw) ? raw : (raw.results ?? [])
    return list.map((p) => ({
      id: p.id,
      identifier: p.identifier,
      name: p.name,
      description: p.description,
      workspaceSlug: slug
    }))
  } catch (error) {
    console.error('[plane] failed to list projects:', error)
    return []
  }
}

export async function listStates(workspaceSlug: string, projectId: string): Promise<PlaneState[]> {
  const client = getClient()
  if (!client) {
    return []
  }
  try {
    const raw = await planeRequest<RawPlaneState[] | { results?: RawPlaneState[] }>(
      client.instanceUrl,
      client.apiToken,
      `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/states/`
    )
    const list = Array.isArray(raw) ? raw : (raw.results ?? [])
    return list.map((s) => ({
      id: s.id,
      name: s.name,
      group: normalizeStateGroup(s.group),
      color: s.color,
      sequence: s.sequence
    }))
  } catch (error) {
    console.error('[plane] failed to list states:', error)
    return []
  }
}
