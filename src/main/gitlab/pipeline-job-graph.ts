import type { GitLabPipelineJob } from '../../shared/gitlab-types'
import { encodedProject } from './project-path-encoding'
import {
  glabHostnameArgs,
  glabRepoExecOptions,
  glabExecFileAsync,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'

// ── Pipeline jobs ──────────────────────────────────────────────────
// Why: GitLab's `/pipelines/:id/jobs` only returns jobs owned by that pipeline.
// Trigger/include bridges live under `/bridges` and their real CI jobs live on
// the child pipeline — Orca used to show only the parent (often just SAST), so
// Checks looked empty next to gitlab.com's full graph.

const PIPELINE_JOB_PAGE_SIZE = 100
/** Cap expanded child-pipeline fan-out so one MR details load stays bounded. */
const MAX_CHILD_PIPELINES_TO_EXPAND = 20
// Why: every fetch spawns a `glab` binary (a remote exec over SSH), and this runs on
// the Checks poll timer. Match gl-utils' MAX_CONCURRENT so a bridge-heavy MR trickles
// its children instead of bursting 20 processes at once.
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
    // Why: bridges are not real jobs — omit a positive id so Checks won't try
    // job-trace/retry APIs on them. Rows still render via name + webUrl.
    id: 0,
    pipelineId,
    name: raw.name ?? 'bridge',
    stage: raw.stage ?? '',
    // Prefer the child pipeline's rollup when present — the bridge job itself
    // often stays `success` while the downstream graph is still running/failed.
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
  // Why: prefer path from web_url so same- and cross-project children both work
  // without a project-id lookup. If the URL is missing/unparseable, fall back to
  // the parent project (same-project triggers); wrong-project calls fail soft.
  const webUrl = bridge.downstream_pipeline?.web_url
  if (webUrl) {
    try {
      const url = new URL(webUrl)
      // web_url shape: https://host/group/project/-/pipelines/123
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
      // fall through to parent project
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

  // Parent jobs first, then each child's jobs. Bridge rollup rows last and only
  // when no expanded child job already carries the same name (avoid duplicates).
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
