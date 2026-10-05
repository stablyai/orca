import type {
  MantisBTProject,
  MantisBTSite,
  MantisBTSiteSelection
} from '../../shared/mantisbt-types'
import { acquire, release } from './request-queue'
import { apiBasePath, mantisBTRequest } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { mapMantisBTProject } from './mantisbt-issue-mapping'
import {
  evictSiteTokenSafely,
  shouldSurfaceSiteFailure,
  withMantisBTDeadline
} from './mantisbt-read-failure'
import type { MantisBTReadFailure } from './mantisbt-read-failure'
import { asRecord } from './mantisbt-record-pages'
import type { MantisBTRecord } from './mantisbt-record-pages'

const PROJECT_LIST_TIMEOUT_MS = 30_000

type MantisBTProjectsResponse = {
  projects?: MantisBTRecord[]
}

function projectDedupeKey(project: MantisBTProject): string {
  return `${project.siteId}:${project.id}`
}

// Why: MantisBT's REST API returns every accessible project as a flat
// top-level entry, and separately (redundantly, only one level deep) nests
// each parent's direct children under its own `subProjects` field — a
// subproject referenced this way does not itself carry its own children.
// Rebuilding a real multi-level tree means resolving each subProjects
// reference back against the full flat list, recursively, and dropping any
// project that is someone else's child from the top-level result (it now
// appears only nested under its parent, matching MantisBT's own
// project-picker sidebar).
function buildMantisBTProjectForest(
  site: MantisBTSite,
  records: MantisBTRecord[]
): MantisBTProject[] {
  const byId = new Map<string, MantisBTRecord>()
  for (const record of records) {
    byId.set(String(record.id), record)
  }
  const childIds = new Set<string>()
  for (const record of records) {
    const subRecords = Array.isArray(record.subProjects) ? record.subProjects : []
    for (const sub of subRecords) {
      const subId = asRecord(sub).id
      if (subId !== undefined) {
        childIds.add(String(subId))
      }
    }
  }
  function resolve(record: MantisBTRecord): MantisBTProject {
    const subRecords = Array.isArray(record.subProjects) ? record.subProjects : []
    const children = subRecords
      .map((sub) => byId.get(String(asRecord(sub).id)))
      .filter((found): found is MantisBTRecord => found !== undefined)
      .map(resolve)
      .sort((a, b) => a.name.localeCompare(b.name))
    return { ...mapMantisBTProject(site, record), subProjects: children }
  }
  return records
    .filter((record) => !childIds.has(String(record.id)))
    .map(resolve)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function listProjects(
  siteId?: MantisBTSiteSelection | null,
  signal?: AbortSignal
): Promise<MantisBTProject[]> {
  const entries = getClients(siteId)
  if (entries.length === 0) {
    return []
  }
  const surfaceSiteFailure = shouldSurfaceSiteFailure(siteId, entries.length)
  const failures: (MantisBTReadFailure | undefined)[] = Array.from({ length: entries.length })
  const results = await withMantisBTDeadline(signal, PROJECT_LIST_TIMEOUT_MS, (requestSignal) =>
    Promise.all(
      entries.map(async (entry, index): Promise<MantisBTProject[]> => {
        await acquire(requestSignal)
        try {
          const response = await mantisBTRequest<MantisBTProjectsResponse>(
            entry,
            `${apiBasePath(entry.site.usePhpIndexPath)}/projects`,
            { signal: requestSignal }
          )
          return buildMantisBTProjectForest(entry.site, response.projects ?? [])
        } catch (error) {
          if (requestSignal.aborted) {
            throw error
          }
          const authFailure = isAuthError(error)
          if (authFailure) {
            evictSiteTokenSafely(clearToken, entry.site.id)
          }
          if (surfaceSiteFailure) {
            throw error
          }
          console.warn('[mantisBT] listProjects failed:', error)
          failures[index] = { error, auth: authFailure }
          return []
        } finally {
          release()
        }
      })
    )
  )
  const recordedFailures = failures.filter(
    (failure): failure is MantisBTReadFailure => failure !== undefined
  )
  if (recordedFailures.length === entries.length) {
    throw (recordedFailures.find((failure) => !failure.auth) ?? recordedFailures[0]).error
  }
  // Why: project ids are unique only within one MantisBT instance (id 1 is the
  // near-universal default project), so an 'all' fan-out dedupes on
  // siteId+id, not the bare id, or two different instances' distinct
  // projects would collide and one would be silently dropped.
  const byKey = new Map<string, MantisBTProject>()
  for (const project of results.flat()) {
    const key = projectDedupeKey(project)
    if (!byKey.has(key)) {
      byKey.set(key, project)
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name))
}
