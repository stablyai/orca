// Why: aggregated detail-fetch for GitLabItemDialog. Parallel of
// src/main/github/work-item-details.ts but scoped to v1 surface —
// description body, flattened discussion notes, MR pipeline jobs.
// Files / inline review-comment positioning / approvals are deferred.
import type {
  GitLabPipelineJob,
  GitLabWorkItem,
  GitLabWorkItemDetails,
  MRComment
} from '../../shared/types'
import { mapIssueToWorkItem, mapMRToWorkItem } from './mappers'
import {
  acquire,
  getGlabKnownHosts,
  getIssueProjectRef,
  getProjectRef,
  glabExecFileAsync,
  release,
  type ProjectRef
} from './gl-utils'

function encodedProject(projectPath: string): string {
  return encodeURIComponent(projectPath)
}

// ── Discussion → MRComment flattening ──────────────────────────────
// GitLab returns discussions with nested notes; the dialog renders a
// flat conversation. We drop system notes ("X assigned the MR", auto-
// generated changelog entries) since they aren't user-authored content.

type GitLabRawNote = {
  id?: number
  body?: string
  author?: { username?: string | null; avatar_url?: string | null; state?: string } | null
  created_at?: string
  system?: boolean
  resolvable?: boolean
  resolved?: boolean
  position?: { new_path?: string; new_line?: number; old_line?: number } | null
}

type GitLabRawDiscussion = {
  id?: string
  individual_note?: boolean
  notes?: GitLabRawNote[]
}

function flattenDiscussions(discussions: GitLabRawDiscussion[]): MRComment[] {
  const out: MRComment[] = []
  for (const discussion of discussions) {
    const notes = discussion.notes ?? []
    for (const note of notes) {
      if (note.system === true) {
        // Why: skip GitLab's auto-generated activity entries — they
        // would dominate a busy MR's conversation tab if rendered.
        continue
      }
      out.push({
        id: note.id ?? 0,
        author: note.author?.username ?? 'unknown',
        authorAvatarUrl: note.author?.avatar_url ?? '',
        body: note.body ?? '',
        createdAt: note.created_at ?? '',
        url: '',
        isBot: note.author?.state === 'bot',
        ...(discussion.id ? { threadId: discussion.id } : {}),
        ...(note.resolvable === true ? { isResolved: note.resolved === true } : {}),
        ...(note.position?.new_path ? { path: note.position.new_path } : {}),
        ...(typeof note.position?.new_line === 'number' ? { line: note.position.new_line } : {})
      })
    }
  }
  // Why: oldest-first matches gitlab.com's conversation rendering and
  // makes "what's new" intuitive when polling for updates later.
  return out.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
}

async function fetchDiscussions(
  repoPath: string,
  projectRef: ProjectRef,
  type: 'issue' | 'mr',
  iid: number
): Promise<GitLabRawDiscussion[]> {
  const resource = type === 'mr' ? 'merge_requests' : 'issues'
  const { stdout } = await glabExecFileAsync(
    [
      'api',
      '--paginate',
      `projects/${encodedProject(projectRef.path)}/${resource}/${iid}/discussions?per_page=100`
    ],
    { cwd: repoPath }
  )
  return JSON.parse(stdout) as GitLabRawDiscussion[]
}

// ── Pipeline jobs ──────────────────────────────────────────────────

type GitLabRawJob = {
  id?: number
  name?: string
  stage?: string
  status?: string
  web_url?: string
  duration?: number | null
}

function mapPipelineJob(raw: GitLabRawJob): GitLabPipelineJob {
  return {
    id: raw.id ?? 0,
    name: raw.name ?? '',
    stage: raw.stage ?? '',
    status: raw.status ?? '',
    webUrl: raw.web_url ?? '',
    duration: typeof raw.duration === 'number' ? raw.duration : null
  }
}

async function fetchPipelineJobs(
  repoPath: string,
  projectRef: ProjectRef,
  pipelineId: number
): Promise<GitLabPipelineJob[]> {
  const { stdout } = await glabExecFileAsync(
    [
      'api',
      '--paginate',
      `projects/${encodedProject(projectRef.path)}/pipelines/${pipelineId}/jobs?per_page=100`
    ],
    { cwd: repoPath }
  )
  const data = JSON.parse(stdout) as GitLabRawJob[]
  return data.map(mapPipelineJob)
}

// ── Top-level aggregator ───────────────────────────────────────────

type GitLabRawIssue = Parameters<typeof mapIssueToWorkItem>[0] & {
  description?: string | null
  assignees?: { username?: string | null }[] | null
}

type GitLabRawMR = Parameters<typeof mapMRToWorkItem>[0] & {
  description?: string | null
  sha?: string
  diff_refs?: { base_sha?: string; head_sha?: string; start_sha?: string } | null
  head_pipeline?: { id?: number } | null
}

/**
 * Fetch full details for a GitLab MR or issue: the work item itself,
 * description body, discussion notes flattened to MRComment[], and (for
 * MRs only) per-job pipeline status.
 *
 * Returns null when the project ref can't be resolved or the item
 * can't be loaded — callers render a "not found" / error state.
 */
export async function getWorkItemDetails(
  repoPath: string,
  iid: number,
  type: 'issue' | 'mr'
): Promise<GitLabWorkItemDetails | null> {
  const knownHosts = await getGlabKnownHosts()
  // Why: issues honor the upstream/origin preference (issues live on
  // upstream when a fork is checked out). MRs always target origin —
  // the fork model puts MRs against the project the user pushes to.
  const projectRef =
    type === 'issue'
      ? await getIssueProjectRef(repoPath, knownHosts)
      : await getProjectRef(repoPath, knownHosts)
  if (!projectRef) {
    return null
  }
  await acquire()
  try {
    if (type === 'issue') {
      return await fetchIssueDetails(repoPath, projectRef, iid)
    }
    return await fetchMRDetails(repoPath, projectRef, iid)
  } catch {
    return null
  } finally {
    release()
  }
}

async function fetchIssueDetails(
  repoPath: string,
  projectRef: ProjectRef,
  iid: number
): Promise<GitLabWorkItemDetails | null> {
  // Why: fan out the two reads. Issues don't have a pipeline so this
  // pair covers everything the dialog renders.
  const [issueRes, discussions] = await Promise.all([
    glabExecFileAsync(['api', `projects/${encodedProject(projectRef.path)}/issues/${iid}`], {
      cwd: repoPath
    }),
    fetchDiscussions(repoPath, projectRef, 'issue', iid)
  ])
  const issueRaw = JSON.parse(issueRes.stdout) as GitLabRawIssue
  const item: Omit<GitLabWorkItem, 'repoId'> = (() => {
    const full = mapIssueToWorkItem(issueRaw, projectRef.path)
    // Why: omit repoId from the returned shape — the renderer stamps
    // it from the dialog's caller (TaskPage / picker) so the main
    // process doesn't need to know Orca's Repo.id.
    const { repoId: _repoId, ...rest } = full
    return rest
  })()
  return {
    item,
    body: issueRaw.description ?? '',
    comments: flattenDiscussions(discussions),
    assignees: (issueRaw.assignees ?? [])
      .map((a) => a?.username)
      .filter((u): u is string => typeof u === 'string')
  }
}

async function fetchMRDetails(
  repoPath: string,
  projectRef: ProjectRef,
  iid: number
): Promise<GitLabWorkItemDetails | null> {
  // Why: MR detail + discussions in parallel. The pipeline jobs fetch
  // depends on `head_pipeline.id` from the MR payload, so it has to
  // wait — but it's a single follow-up call rather than a serial chain.
  const [mrRes, discussions] = await Promise.all([
    glabExecFileAsync(
      ['api', `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}`],
      { cwd: repoPath }
    ),
    fetchDiscussions(repoPath, projectRef, 'mr', iid)
  ])
  const mrRaw = JSON.parse(mrRes.stdout) as GitLabRawMR
  const item: Omit<GitLabWorkItem, 'repoId'> = (() => {
    const full = mapMRToWorkItem(mrRaw, projectRef.path)
    const { repoId: _repoId, ...rest } = full
    return rest
  })()
  const pipelineId = mrRaw.head_pipeline?.id
  const pipelineJobs =
    typeof pipelineId === 'number'
      ? await fetchPipelineJobs(repoPath, projectRef, pipelineId).catch(() => [])
      : undefined
  return {
    item,
    body: mrRaw.description ?? '',
    comments: flattenDiscussions(discussions),
    headSha: mrRaw.sha,
    baseSha: mrRaw.diff_refs?.base_sha,
    ...(pipelineJobs !== undefined ? { pipelineJobs } : {})
  }
}
