import type { ItsaplanProject, ItsaplanProjectMetadata } from '../../shared/itsaplan/itsaplan-types'
import { ItsaplanApiError, itsaplanRequest } from './client'
import {
  mapItsaplanProjectMetadata,
  type ItsaplanRawColumn,
  type ItsaplanRawLabel,
  type ItsaplanRawMember,
  type ItsaplanRawProject
} from './itsaplan-issue-mapping'

const CACHE_TTL_MS = 60_000

type RawProjectListItem = ItsaplanRawProject & { archivedAt?: string | null }
type RawProjectBoard = {
  project: ItsaplanRawProject
  columns: ItsaplanRawColumn[]
  labels: ItsaplanRawLabel[]
  assignees: ItsaplanRawMember[]
}

const metadataCache = new Map<string, { expiresAt: number; value: ItsaplanProjectMetadata }>()
let projectIndexCache: { expiresAt: number; projects: ItsaplanProject[] } | null = null

export function clearItsaplanProjectCaches(): void {
  metadataCache.clear()
  projectIndexCache = null
}

function toProject(raw: ItsaplanRawProject): ItsaplanProject {
  return { id: raw.id, ref: raw.ref, key: raw.key, name: raw.name }
}

async function fetchProjects(query?: string): Promise<ItsaplanProject[]> {
  const raw = await itsaplanRequest<RawProjectListItem[]>('/projects', {
    query: { q: query?.trim() || undefined }
  })
  return raw.filter((project) => !project.archivedAt).map(toProject)
}

export async function itsaplanListProjects(args?: { query?: string }): Promise<ItsaplanProject[]> {
  return fetchProjects(args?.query)
}

/** Issue payloads carry only projectId; metadata is addressed by ref. */
export async function resolveItsaplanProjectRef(
  projectId: number,
  knownRef?: string
): Promise<string> {
  if (
    knownRef &&
    (await itsaplanGetProjectMetadata({ projectRef: knownRef })).project.id === projectId
  ) {
    return knownRef
  }
  const findProject = () =>
    projectIndexCache?.projects.find((candidate) => candidate.id === projectId)
  let project =
    projectIndexCache && projectIndexCache.expiresAt >= Date.now() ? findProject() : undefined
  if (!project) {
    // A miss may be a project created or joined since the index was cached, so refetch once.
    projectIndexCache = { expiresAt: Date.now() + CACHE_TTL_MS, projects: await fetchProjects() }
    project = findProject()
  }
  if (!project) {
    throw new ItsaplanApiError('notFound')
  }
  return project.ref
}

export async function itsaplanGetProjectMetadata(args: {
  projectRef: string
}): Promise<ItsaplanProjectMetadata> {
  const cached = metadataCache.get(args.projectRef)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }
  const board = await itsaplanRequest<RawProjectBoard>(
    `/projects/${encodeURIComponent(args.projectRef)}`
  )
  const value = mapItsaplanProjectMetadata(
    board.project,
    board.columns,
    board.labels,
    board.assignees
  )
  metadataCache.set(args.projectRef, { expiresAt: Date.now() + CACHE_TTL_MS, value })
  return value
}
