import type { GitLabPipelineJob } from '../../shared/gitlab-types'
import { encodedProject } from './project-path-encoding'
import {
  glabHostnameArgs,
  glabRepoExecOptions,
  glabExecFileAsync,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'

// Child CI jobs live under bridge pipelines, not the parent pipeline's jobs endpoint.

const PIPELINE_JOB_PAGE_SIZE = 100
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
}

type GitLabRawBridge = {
  id?: number
  name?: string
  stage?: string
  status?: string
  web_url?: string
  duration?: number | null
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
    duration: typeof raw.duration === 'number' ? raw.duration : null
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
    duration: typeof raw.duration === 'number' ? raw.duration : null
  }
}

async function fetchPipelineJobPage(
  repoPath: string,
  projectRef: ProjectRef,
  pipelineId: number,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions
): Promise<GitLabPipelineJob[]> {
  const { stdout } = await glabExecFileAsync(
    [
      'api',
      ...glabHostnameArgs(projectRef, connectionId),
      `projects/${encodedProject(projectRef.path)}/pipelines/${pipelineId}/jobs?per_page=${PIPELINE_JOB_PAGE_SIZE}`
    ],
    glabRepoExecOptions(repoPath, connectionId, localGitOptions)
  )
  const data = JSON.parse(stdout) as GitLabRawJob[]
  if (!Array.isArray(data)) {
    return []
  }
  return data.map((job) => mapPipelineJob(job, pipelineId))
}

async function fetchPipelineBridges(
  repoPath: string,
  projectRef: ProjectRef,
  pipelineId: number,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions
): Promise<GitLabRawBridge[]> {
  const { stdout } = await glabExecFileAsync(
    [
      'api',
      ...glabHostnameArgs(projectRef, connectionId),
      `projects/${encodedProject(projectRef.path)}/pipelines/${pipelineId}/bridges?per_page=${PIPELINE_JOB_PAGE_SIZE}`
    ],
    glabRepoExecOptions(repoPath, connectionId, localGitOptions)
  )
  const data = JSON.parse(stdout) as GitLabRawBridge[]
  return Array.isArray(data) ? data : []
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
  const [parentJobs, bridges] = await Promise.all([
    fetchPipelineJobPage(repoPath, projectRef, pipelineId, connectionId, localGitOptions),
    fetchPipelineBridges(repoPath, projectRef, pipelineId, connectionId, localGitOptions).catch(
      () => [] as GitLabRawBridge[]
    )
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
      fetchPipelineJobPage(
        repoPath,
        target.projectRef,
        target.pipelineId,
        connectionId,
        localGitOptions
      ).catch(() => [] as GitLabPipelineJob[])
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
