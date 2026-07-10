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
import type { IssueSourcePreference } from '../../shared/types'

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

type GitLabRawJob = {
  id?: number
  name?: string
  stage?: string
  status?: string
  web_url?: string
  duration?: number | null
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

async function fetchPipelineJobs(
  repoPath: string,
  projectRef: ProjectRef,
  pipelineId: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabPipelineJob[]> {
  const { stdout } = await glabExecFileAsync(
    [
      'api',
      ...glabHostnameArgs(projectRef, connectionId),
      // Why: one MR details load should not fetch every job page from very
      // large pipelines; the first 100 jobs match the visible summary budget.
      `projects/${encodedProject(projectRef.path)}/pipelines/${pipelineId}/jobs?per_page=100`
    ],
    glabRepoExecOptions(repoPath, connectionId, localGitOptions)
  )
  const data = JSON.parse(stdout) as GitLabRawJob[]
  return data.map((job) => mapPipelineJob(job, pipelineId))
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) {
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
        await getGlabKnownHosts(connectionId),
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
