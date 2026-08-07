/* eslint-disable max-lines -- Why: aggregated detail-fetch for GitLabItemDialog spans issues, MRs, comments, pipelines, reviewers, approvals, and changed files; splitting would obscure the shared fetch context. */
// Why: aggregated detail-fetch for GitLabItemDialog. Parallel of
// src/main/github/work-item-details.ts but scoped to v1 surface —
// description body, flattened discussion notes, MR pipeline jobs/reviewers.
// Files / inline review-comment positioning are deferred.
import type {
  GitLabAssignableUser,
  GitLabMRApprovalState,
  GitLabMRFile,
  GitLabPipelineJob,
  GitLabWorkItem,
  GitLabWorkItemDetails,
  IssueSourcePreference,
  MRComment
} from '../../shared/types'
import { mapIssueToWorkItem, mapMRToWorkItem } from './mappers'
import {
  acquire,
  getGlabKnownHosts,
  glabHostnameArgs,
  glabRepoExecOptions,
  glabExecFileAsync,
  release,
  resolveIssueSource,
  type LocalGitExecOptions,
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
  iid: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabRawDiscussion[]> {
  const resource = type === 'mr' ? 'merge_requests' : 'issues'
  const { stdout } = await glabExecFileAsync(
    [
      'api',
      ...glabHostnameArgs(projectRef, connectionId),
      // Why: detail drawers need a bounded recent conversation snapshot.
      // Walking every historic discussion can retain and render huge note sets.
      `projects/${encodedProject(projectRef.path)}/${resource}/${iid}/discussions?per_page=100`
    ],
    glabRepoExecOptions(repoPath, connectionId, localGitOptions)
  )
  return JSON.parse(stdout) as GitLabRawDiscussion[]
}

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

type GitLabRawUser = {
  id?: number
  username?: string | null
  name?: string | null
  avatar_url?: string | null
  state?: string | null
}

function mapGitLabUser(raw: GitLabRawUser | null | undefined): GitLabAssignableUser | null {
  if (!raw?.username) {
    return null
  }
  return {
    ...(typeof raw.id === 'number' ? { id: raw.id } : {}),
    username: raw.username,
    name: raw.name ?? null,
    avatarUrl: raw.avatar_url ?? '',
    ...(raw.state !== undefined ? { state: raw.state } : {})
  }
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

async function fetchPipelineJobs(
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

/**
 * Counts the added/removed lines in a single GitLab MR file's unified diff,
 * feeding the +N/-N shown in the MR file list. `---`/`+++` are file headers
 * only before the first `@@` hunk; every `+`/`-` line inside a hunk is content.
 * Requires hunk headers: a diff with no `@@` counts zero, so do not reuse this
 * for header-less agent-tool diffs (see `diffFromText` in shared/native-chat-diff).
 *
 * @internal - exposed for tests only.
 */
export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  // Why: `---`/`+++` are file headers only before the first hunk. A removed line
  // whose original text began with `--` (SQL/Lua/Haskell `-- comment`) becomes a
  // diff line `---<content>`, colliding with the `--- a/file` header — so it must
  // be counted once inside a hunk, not skipped.
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk) {
      continue
    }
    if (line.startsWith('+')) {
      additions += 1
    } else if (line.startsWith('-')) {
      deletions += 1
    }
  }
  return { additions, deletions }
}

function mapMRFile(raw: {
  new_path?: string
  old_path?: string
  diff?: string
  new_file?: boolean
  deleted_file?: boolean
  renamed_file?: boolean
  binary?: boolean
  too_large?: boolean
}): GitLabMRFile {
  const diff = raw.diff ?? ''
  const counts = countDiffLines(diff)
  const status = raw.new_file
    ? 'added'
    : raw.deleted_file
      ? 'removed'
      : raw.renamed_file
        ? 'renamed'
        : 'modified'
  return {
    path: raw.new_path ?? raw.old_path ?? '',
    ...(raw.old_path && raw.old_path !== raw.new_path ? { oldPath: raw.old_path } : {}),
    status,
    additions: counts.additions,
    deletions: counts.deletions,
    isBinary: Boolean(raw.binary || raw.too_large || !diff),
    ...(diff ? { diff } : {})
  }
}

async function fetchMRFiles(
  repoPath: string,
  projectRef: ProjectRef,
  iid: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabMRFile[]> {
  const { stdout } = await glabExecFileAsync(
    [
      'api',
      ...glabHostnameArgs(projectRef, connectionId),
      // Why: GitLab deprecated the all-in-one `changes` endpoint in favor of
      // the paginated diffs endpoint; cap the file snapshot at one visible page.
      `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/diffs?per_page=100`
    ],
    glabRepoExecOptions(repoPath, connectionId, localGitOptions)
  )
  const data = JSON.parse(stdout) as Parameters<typeof mapMRFile>[0][]
  return data.map(mapMRFile).filter((file) => file.path)
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
  reviewers?: GitLabRawUser[] | null
}

async function fetchMRReviewers(
  repoPath: string,
  projectRef: ProjectRef,
  iid: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabAssignableUser[]> {
  const { stdout } = await glabExecFileAsync(
    [
      'api',
      ...glabHostnameArgs(projectRef, connectionId),
      `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/reviewers`
    ],
    glabRepoExecOptions(repoPath, connectionId, localGitOptions)
  )
  const data = JSON.parse(stdout) as { user?: GitLabRawUser | null }[]
  return data
    .map((entry) => mapGitLabUser(entry.user))
    .filter((u): u is GitLabAssignableUser => !!u)
}

async function fetchMRApprovalState(
  repoPath: string,
  projectRef: ProjectRef,
  iid: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabMRApprovalState | undefined> {
  const [approvalsRes, stateRes] = await Promise.allSettled([
    glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/approvals`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    ),
    glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/approval_state`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
  ])
  if (approvalsRes.status === 'rejected' && stateRes.status === 'rejected') {
    return undefined
  }
  const approvals =
    approvalsRes.status === 'fulfilled'
      ? (JSON.parse(approvalsRes.value.stdout) as {
          approvals_required?: number | null
          approvals_left?: number | null
          approved_by?: { user?: GitLabRawUser | null }[]
        })
      : null
  const state =
    stateRes.status === 'fulfilled'
      ? (JSON.parse(stateRes.value.stdout) as {
          rules?: {
            id?: number
            name?: string
            approvals_required?: number
            approved?: boolean
          }[]
        })
      : null
  return {
    approvalsRequired:
      typeof approvals?.approvals_required === 'number' ? approvals.approvals_required : null,
    approvalsLeft: typeof approvals?.approvals_left === 'number' ? approvals.approvals_left : null,
    approvedBy: (approvals?.approved_by ?? [])
      .map((entry) => mapGitLabUser(entry.user))
      .filter((u): u is GitLabAssignableUser => !!u),
    rules: (state?.rules ?? []).map((rule) => ({
      id: rule.id ?? 0,
      name: rule.name ?? 'Approval rule',
      approvalsRequired: rule.approvals_required ?? 0,
      approved: Boolean(rule.approved)
    }))
  }
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
  type: 'issue' | 'mr',
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRefOverride?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabWorkItemDetails | null> {
  // Why: detail fetches must use the same project source as the list row
  // that opened them, otherwise forked repos can show a row from one remote
  // and a detail sheet from another.
  const projectRef =
    projectRefOverride ??
    (
      await resolveIssueSource(
        repoPath,
        preference,
        await getGlabKnownHosts(connectionId, localGitOptions),
        connectionId,
        localGitOptions
      )
    ).source
  if (!projectRef) {
    return null
  }
  await acquire()
  try {
    if (type === 'issue') {
      return await fetchIssueDetails(repoPath, projectRef, iid, connectionId, localGitOptions)
    }
    return await fetchMRDetails(repoPath, projectRef, iid, connectionId, localGitOptions)
  } catch {
    return null
  } finally {
    release()
  }
}

async function fetchIssueDetails(
  repoPath: string,
  projectRef: ProjectRef,
  iid: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabWorkItemDetails | null> {
  // Why: fan out the two reads. Issues don't have a pipeline so this
  // pair covers everything the dialog renders.
  const [issueRes, discussions] = await Promise.all([
    glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/issues/${iid}`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    ),
    fetchDiscussions(repoPath, projectRef, 'issue', iid, connectionId, localGitOptions)
  ])
  const issueRaw = JSON.parse(issueRes.stdout) as GitLabRawIssue
  const item: Omit<GitLabWorkItem, 'repoId'> = (() => {
    const full = mapIssueToWorkItem(issueRaw, projectRef.path, projectRef)
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
  iid: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabWorkItemDetails | null> {
  // Why: MR detail + discussions in parallel. The pipeline jobs fetch
  // depends on `head_pipeline.id` from the MR payload, so it has to
  // wait — but it's a single follow-up call rather than a serial chain.
  const [mrRes, discussions] = await Promise.all([
    glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    ),
    fetchDiscussions(repoPath, projectRef, 'mr', iid, connectionId, localGitOptions)
  ])
  const mrRaw = JSON.parse(mrRes.stdout) as GitLabRawMR
  const item: Omit<GitLabWorkItem, 'repoId'> = (() => {
    const full = mapMRToWorkItem(mrRaw, projectRef.path, projectRef)
    const { repoId: _repoId, ...rest } = full
    return rest
  })()
  const pipelineId = mrRaw.head_pipeline?.id
  const pipelineJobs =
    typeof pipelineId === 'number'
      ? await fetchPipelineJobs(
          repoPath,
          projectRef,
          pipelineId,
          connectionId,
          localGitOptions
        ).catch(() => [])
      : undefined
  const [reviewers, approvalState, files] = await Promise.all([
    fetchMRReviewers(repoPath, projectRef, iid, connectionId, localGitOptions).catch(() =>
      (mrRaw.reviewers ?? []).map(mapGitLabUser).filter((u): u is GitLabAssignableUser => !!u)
    ),
    fetchMRApprovalState(repoPath, projectRef, iid, connectionId, localGitOptions).catch(
      () => undefined
    ),
    fetchMRFiles(repoPath, projectRef, iid, connectionId, localGitOptions).catch(() => [])
  ])
  return {
    item,
    body: mrRaw.description ?? '',
    comments: flattenDiscussions(discussions),
    headSha: mrRaw.sha,
    baseSha: mrRaw.diff_refs?.base_sha,
    startSha: mrRaw.diff_refs?.start_sha,
    files,
    ...(pipelineJobs !== undefined ? { pipelineJobs } : {}),
    reviewers,
    ...(approvalState ? { approvalState } : {})
  }
}
