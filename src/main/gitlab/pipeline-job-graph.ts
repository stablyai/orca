import type { GitLabPipelineJob } from '../../shared/gitlab-types'
import { encodedProject } from './project-path-encoding'
import { gitLabRunTimes } from './gitlab-run-times'
import { fetchAllGitLabPages, GitLabIncompletePaginationError } from './gitlab-paginated-list'
import type { LocalGitExecOptions, ProjectRef } from './gl-utils'

// Child CI jobs live under bridge pipelines, not the parent pipeline's jobs endpoint.

// Bound child-pipeline expansion per details load.
const MAX_CHILD_PIPELINES_TO_EXPAND = 20
// Each fetch launches glab; cap polling fan-out to match the shared CLI admission limit.
const MAX_CONCURRENT_CHILD_FETCHES = 4

type GitLabRawJob = {
  id?: number
  name?: string
  stage?: string
  status?: string
  web_url?: string
  duration?: number | null
  started_at?: string | null
  finished_at?: string | null
}

type GitLabRawBridge = {
  id?: number
  name?: string
  stage?: string
  status?: string
  web_url?: string
  duration?: number | null
  started_at?: string | null
  finished_at?: string | null
  downstream_pipeline?: {
    id?: number
    project_id?: number
    status?: string
    web_url?: string
  } | null
}

function mapPipelineJob(raw: GitLabRawJob, pipelineId: number): GitLabPipelineJob {
  return {
    id: raw.id ?? 0,
    pipelineId,
    name: raw.name ?? '',
    stage: raw.stage ?? '',
    status: raw.status ?? '',
    webUrl: raw.web_url ?? '',
    duration: typeof raw.duration === 'number' ? raw.duration : null,
    ...gitLabRunTimes(raw)
  }
}

function mapBridgeAsJob(raw: GitLabRawBridge, pipelineId: number): GitLabPipelineJob {
  const childStatus = raw.downstream_pipeline?.status
  return {
    // Bridges have no real job ID; prevent Checks from calling trace/retry APIs on them.
    id: 0,
    pipelineId,
    name: raw.name ?? 'bridge',
    stage: raw.stage ?? '',
    // Bridge status may remain successful while its downstream pipeline is running or failed.
    status: childStatus || raw.status || '',
    webUrl: raw.downstream_pipeline?.web_url ?? raw.web_url ?? '',
    duration: typeof raw.duration === 'number' ? raw.duration : null,
    // The trigger job's own times can end long before the child pipeline it now stands for.
    ...(childStatus ? {} : gitLabRunTimes(raw))
  }
}

async function fetchPipelineJobList(
  repoPath: string,
  projectRef: ProjectRef,
  pipelineId: number,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions,
  signal: AbortSignal
): Promise<GitLabPipelineJob[]> {
  const jobs = await fetchAllGitLabPages<GitLabRawJob>(
    repoPath,
    projectRef,
    `projects/${encodedProject(projectRef.path)}/pipelines/${pipelineId}/jobs`,
    connectionId,
    localGitOptions,
    signal
  )
  return jobs.map((job) => mapPipelineJob(job, pipelineId))
}

async function fetchPipelineBridges(
  repoPath: string,
  projectRef: ProjectRef,
  pipelineId: number,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions,
  signal: AbortSignal
): Promise<GitLabRawBridge[]> {
  return fetchAllGitLabPages<GitLabRawBridge>(
    repoPath,
    projectRef,
    `projects/${encodedProject(projectRef.path)}/pipelines/${pipelineId}/bridges`,
    connectionId,
    localGitOptions,
    signal
  )
}

function childPipelineTarget(
  bridge: GitLabRawBridge,
  parentProjectRef: ProjectRef
): { projectRef: ProjectRef; pipelineId: number } | null {
  const childId = bridge.downstream_pipeline?.id
  if (typeof childId !== 'number') {
    return null
  }
  // Derive cross-project child paths from web URLs; missing URLs fall back to same-project lookup.
  const webUrl = bridge.downstream_pipeline?.web_url
  if (webUrl) {
    try {
      const url = new URL(webUrl)
      const marker = url.pathname.indexOf('/-/pipelines/')
      if (marker > 0) {
        const path = url.pathname.slice(1, marker).replace(/\/$/, '')
        if (path) {
          return {
            projectRef: { host: url.host || parentProjectRef.host, path },
            pipelineId: childId
          }
        }
      }
    } catch {
      // Fall back to the parent project.
    }
  }
  return { projectRef: parentProjectRef, pipelineId: childId }
}

/** Results stay in input order; a shared cursor keeps fast workers from idling behind a slow batch. */
async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const out = Array.from({ length: items.length }) as R[]
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor
        cursor += 1
        out[index] = await run(items[index])
      }
    })
  )
  return out
}

export async function fetchPipelineJobs(
  repoPath: string,
  projectRef: ProjectRef,
  pipelineId: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabPipelineJob[]> {
  // Once the graph has failed, stop sibling page walks nobody will read.
  const graphFailed = new AbortController()
  const failGraph = (error: unknown): never => {
    graphFailed.abort()
    throw error
  }
  // Bridges and children tolerate a failed first page (e.g. a forbidden child project), never a partial list.
  const tolerateUnreadable =
    <T>(fallback: T) =>
    (error: unknown): T =>
      error instanceof GitLabIncompletePaginationError ? failGraph(error) : fallback

  const [parentJobs, bridges] = await Promise.all([
    fetchPipelineJobList(
      repoPath,
      projectRef,
      pipelineId,
      connectionId,
      localGitOptions,
      graphFailed.signal
    ).catch(failGraph),
    fetchPipelineBridges(
      repoPath,
      projectRef,
      pipelineId,
      connectionId,
      localGitOptions,
      graphFailed.signal
    ).catch(tolerateUnreadable([] as GitLabRawBridge[]))
  ])

  const bridgeRows = bridges.map((bridge) => mapBridgeAsJob(bridge, pipelineId))
  const childTargets: { projectRef: ProjectRef; pipelineId: number }[] = []
  const seenChildIds = new Set<number>()
  for (const bridge of bridges) {
    const target = childPipelineTarget(bridge, projectRef)
    if (!target || seenChildIds.has(target.pipelineId)) {
      continue
    }
    seenChildIds.add(target.pipelineId)
    childTargets.push(target)
    if (childTargets.length >= MAX_CHILD_PIPELINES_TO_EXPAND) {
      break
    }
  }

  const childJobBatches = await mapWithConcurrencyLimit(
    childTargets,
    MAX_CONCURRENT_CHILD_FETCHES,
    (target) =>
      fetchPipelineJobList(
        repoPath,
        target.projectRef,
        target.pipelineId,
        connectionId,
        localGitOptions,
        graphFailed.signal
      ).catch(tolerateUnreadable([] as GitLabPipelineJob[]))
  )

  // Keep parent/child job order, and add bridge rollups only when no expanded job shares their name.
  const seenJobIds = new Set<number>()
  const seenNames = new Set<string>()
  const out: GitLabPipelineJob[] = []
  for (const job of [...parentJobs, ...childJobBatches.flat()]) {
    if (job.id) {
      if (seenJobIds.has(job.id)) {
        continue
      }
      seenJobIds.add(job.id)
    }
    out.push(job)
    if (job.name) {
      seenNames.add(job.name)
    }
  }
  for (const bridge of bridgeRows) {
    if (bridge.name && seenNames.has(bridge.name)) {
      continue
    }
    out.push(bridge)
    if (bridge.name) {
      seenNames.add(bridge.name)
    }
  }
  return out
}
