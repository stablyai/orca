import type { PlaneLabel, PlaneMember, PlaneProject, PlaneState } from '../../shared/plane-types'
import {
  buildQuery,
  planeRequest,
  workspacePath,
  type PlaneClientForWorkspace
} from './authenticated-request'
import { PLANE_PAGE_SIZE, listAllPages } from './cursor-pagination'
import { mapPlaneLabel, mapPlaneMember, mapPlaneProject, mapPlaneState } from './work-item-mapping'

const METADATA_MAX_ITEMS = 500

function page(
  client: PlaneClientForWorkspace,
  path: string,
  query: Record<string, unknown> = {}
): (cursor: string | undefined) => Promise<unknown> {
  return (cursor) =>
    planeRequest(
      client,
      `${workspacePath(client.workspace, path)}${buildQuery({
        per_page: PLANE_PAGE_SIZE,
        ...query,
        ...(cursor ? { cursor } : {})
      })}`
    )
}

export async function listProjects(client: PlaneClientForWorkspace): Promise<PlaneProject[]> {
  const { items } = await listAllPages<unknown>(page(client, 'projects/'), {
    maxItems: METADATA_MAX_ITEMS
  })
  return items
    .map((raw) => mapPlaneProject(raw, client.workspace))
    .filter((project): project is PlaneProject => project !== null)
}

export async function findProjectByIdentifier(
  client: PlaneClientForWorkspace,
  identifier: string
): Promise<PlaneProject | null> {
  const wanted = identifier.trim().toUpperCase()
  const projects = await listProjects(client)
  return projects.find((project) => project.identifier === wanted) ?? null
}

export async function listStates(
  client: PlaneClientForWorkspace,
  projectId: string
): Promise<PlaneState[]> {
  const { items } = await listAllPages<unknown>(
    page(client, `projects/${encodeURIComponent(projectId)}/states/`),
    { maxItems: METADATA_MAX_ITEMS }
  )
  return items
    .map((raw) => mapPlaneState(raw))
    .filter((state): state is PlaneState => state !== null)
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
}

export async function listLabels(
  client: PlaneClientForWorkspace,
  projectId: string
): Promise<PlaneLabel[]> {
  const { items } = await listAllPages<unknown>(
    page(client, `projects/${encodeURIComponent(projectId)}/labels/`),
    { maxItems: METADATA_MAX_ITEMS }
  )
  return items
    .map((raw) => mapPlaneLabel(raw))
    .filter((label): label is PlaneLabel => label !== null)
}

export async function listWorkspaceMembers(
  client: PlaneClientForWorkspace
): Promise<PlaneMember[]> {
  const { items } = await listAllPages<unknown>(page(client, 'members/'), {
    maxItems: METADATA_MAX_ITEMS
  })
  return items
    .map((raw) => mapPlaneMember(raw))
    .filter((member): member is PlaneMember => member !== null)
}

/** Picks the state a lifecycle action should move a work item into. */
export function pickStateForGroup(
  states: readonly PlaneState[],
  group: PlaneState['group'],
  explicitName?: string | null
): PlaneState | null {
  if (explicitName) {
    const wanted = explicitName.trim().toLowerCase()
    return states.find((state) => state.name.toLowerCase() === wanted) ?? null
  }
  const inGroup = states.filter((state) => state.group === group)
  return inGroup.find((state) => state.default) ?? inGroup[0] ?? null
}
