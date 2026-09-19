import { parsePlaneIssueUrl } from '../../shared/plane/links'
import type { PlaneIssue, PlaneState } from '../../shared/plane-types'
import { getClient } from './client'
import { getIssue, listIssues, listProjects, listStates } from './issues'

export type ResolvedPlaneIssueTarget = {
  workspaceSlug: string
  projectId: string
  issueId: string
  issue?: PlaneIssue
}

export async function resolvePlaneIssueTarget(
  input: string,
  workspaceSlug?: string,
  projectId?: string
): Promise<ResolvedPlaneIssueTarget> {
  const client = getClient()
  if (!client) {
    throw new Error('Plane is not connected')
  }

  // 1. Check if input is a Plane issue URL
  const parsedUrl = parsePlaneIssueUrl(input)
  if (parsedUrl) {
    return {
      workspaceSlug: parsedUrl.workspaceSlug,
      projectId: parsedUrl.projectId,
      issueId: parsedUrl.issueId
    }
  }

  const slug = workspaceSlug || client.activeWorkspaceSlug
  if (!slug) {
    throw new Error('No Plane workspace specified and no active workspace selected')
  }

  // 2. Check if input is a Key like PROJ-123
  const keyMatch = /^([A-Za-z0-9_]+)-(\d+)$/.exec(input.trim())
  if (keyMatch) {
    const projectIdentifier = keyMatch[1].toUpperCase()
    const sequenceId = Number(keyMatch[2])

    let resolvedProjectId = projectId
    if (!resolvedProjectId) {
      const projects = await listProjects(slug)
      const foundProject = projects.find(
        (p) => p.identifier.toUpperCase() === projectIdentifier
      )
      if (!foundProject) {
        throw new Error(`Project with identifier "${projectIdentifier}" not found in workspace "${slug}"`)
      }
      resolvedProjectId = foundProject.id
    }

    const issues = await listIssues({ workspaceSlug: slug, projectId: resolvedProjectId })
    const foundIssue = issues.find((item) => item.sequenceId === sequenceId || item.key.toUpperCase() === input.trim().toUpperCase())
    if (foundIssue) {
      return {
        workspaceSlug: slug,
        projectId: resolvedProjectId,
        issueId: foundIssue.id,
        issue: foundIssue
      }
    }
    throw new Error(`Issue "${input}" not found in project "${resolvedProjectId}"`)
  }

  // 3. Input is a direct ID (UUID or similar)
  if (projectId) {
    return {
      workspaceSlug: slug,
      projectId,
      issueId: input.trim()
    }
  }

  // Search across projects in workspace to locate the issue
  const projects = await listProjects(slug)
  for (const project of projects) {
    const direct = await getIssue(slug, project.id, input.trim())
    if (direct) {
      return {
        workspaceSlug: slug,
        projectId: project.id,
        issueId: direct.id,
        issue: direct
      }
    }
  }

  throw new Error(`Issue "${input}" could not be resolved in workspace "${slug}"`)
}

export async function resolvePlaneStateTarget(
  workspaceSlug: string,
  projectId: string,
  stateNameOrId: string
): Promise<PlaneState> {
  const states = await listStates(workspaceSlug, projectId)
  const trimmed = stateNameOrId.trim()
  const matched = states.find(
    (s) => s.id === trimmed || s.name.toLowerCase() === trimmed.toLowerCase()
  )
  if (!matched) {
    const available = states.map((s) => `"${s.name}"`).join(', ')
    throw new Error(
      `State "${stateNameOrId}" not found for project. Available states: ${available || 'none'}`
    )
  }
  return matched
}
