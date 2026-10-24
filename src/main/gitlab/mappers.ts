import type { CheckStatus } from '../../shared/github/pull-request-types'
import type { GitLabIssueInfo, GitLabWorkItem, MRInfo, MRState } from '../../shared/gitlab-types'
import {
  mapGitLabPipelineJobStatusToCheckStatus,
  mapGitLabPipelineJobStatusToConclusion
} from '../../shared/gitlab-pipeline-checks'
import { summarizeProviderChecks } from '../../shared/provider-check-summary'

// Split GitLab's combined job lifecycle/outcome into the common check-row shape.

export const mapPipelineJobStatusToCheckStatus = mapGitLabPipelineJobStatusToCheckStatus
export const mapPipelineJobStatusToConclusion = mapGitLabPipelineJobStatusToConclusion

export function mapMRState(state: string, isDraft?: boolean, title?: string): MRState {
  const s = state?.toLowerCase()
  if (s === 'merged') {
    return 'merged'
  }
  if (s === 'closed') {
    return 'closed'
  }
  if (s === 'locked') {
    return 'locked'
  }
  // Accept modern draft flags and legacy Draft:/WIP: title prefixes.
  if (isDraft || (title && /^(draft|wip):\s*/i.test(title))) {
    return 'draft'
  }
  return 'opened'
}

export function mapGitLabIssueInfo(data: {
  iid?: number
  number?: number
  title: string
  state: string
  web_url?: string
  url?: string
  labels?: { name: string }[] | string[]
  updated_at?: string
  description?: string | null
  author?: { username?: string | null; avatar_url?: string | null } | null
}): GitLabIssueInfo {
  // glab commands vary between iid and number field names.
  const number = data.iid ?? data.number ?? 0
  const labels = (data.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
  return {
    number,
    title: data.title,
    state: data.state?.toLowerCase() === 'opened' ? 'opened' : 'closed',
    url: data.web_url ?? data.url ?? '',
    labels,
    ...(data.updated_at ? { updatedAt: data.updated_at } : {}),
    // Preserve absent list metadata separately from known blank detail fields.
    ...(typeof data.description === 'string' ? { description: data.description } : {}),
    ...(data.author?.username ? { author: data.author.username } : {}),
    ...(data.author?.avatar_url ? { authorAvatarUrl: data.author.avatar_url } : {})
  }
}

type GitLabMRRaw = {
  iid?: number
  number?: number
  title: string
  state: string
  draft?: boolean
  web_url?: string
  url?: string
  updated_at?: string
  updatedAt?: string
  sha?: string
  has_conflicts?: boolean
  detailed_merge_status?: string
  /** Deprecated since GitLab 15.6, but the only merge signal older instances return. */
  merge_status?: string
  description?: string | null
  target_branch?: string
  author?: { username?: string | null; avatar_url?: string | null } | null
}

export function mapMRInfo(data: GitLabMRRaw, pipelineStatus: CheckStatus): MRInfo {
  const mergeable = deriveMergeable(data)
  const mergeStateStatus = deriveMergeStateStatus(data, mergeable)
  return {
    number: data.iid ?? data.number ?? 0,
    title: data.title,
    state: mapMRState(data.state, data.draft, data.title),
    url: data.web_url ?? data.url ?? '',
    pipelineStatus,
    updatedAt: data.updated_at ?? data.updatedAt ?? '',
    mergeable,
    ...(mergeStateStatus ? { mergeStateStatus } : {}),
    headSha: data.sha,
    baseRefName: data.target_branch,
    // Preserve unknown list bodies as absent, distinct from known empty descriptions.
    ...(typeof data.description === 'string' ? { description: data.description } : {}),
    ...(data.author?.username ? { author: data.author.username } : {}),
    ...(data.author?.avatar_url ? { authorAvatarUrl: data.author.avatar_url } : {})
  }
}

function deriveMergeable(data: GitLabMRRaw): MRInfo['mergeable'] {
  if (data.has_conflicts === true) {
    return 'CONFLICTING'
  }
  // Only positive mergeable is stable enough to enable merging; pending prerequisites remain unknown.
  if (data.detailed_merge_status === 'mergeable') {
    return 'MERGEABLE'
  }
  if (data.detailed_merge_status === 'broken_status' || data.detailed_merge_status === 'conflict') {
    return 'CONFLICTING'
  }
  // GitLab <15.6 supplies only legacy merge_status; trust its positive value while conflicts use has_conflicts.
  if (data.detailed_merge_status === undefined && data.merge_status === 'can_be_merged') {
    return 'MERGEABLE'
  }
  return 'UNKNOWN'
}

function deriveMergeStateStatus(
  data: GitLabMRRaw,
  mergeable: MRInfo['mergeable']
): string | undefined {
  if (mergeable === 'CONFLICTING') {
    return 'conflict'
  }
  if (mergeable === 'MERGEABLE') {
    return 'mergeable'
  }
  const status = data.detailed_merge_status?.toLowerCase()
  if (!status) {
    return undefined
  }
  return status
}

export function derivePipelineStatus(
  rollup: { status?: string }[] | { status?: string } | string | null | undefined
): CheckStatus {
  if (!rollup) {
    return 'neutral'
  }
  if (typeof rollup === 'string') {
    return classifyPipelineString(rollup)
  }
  if (!Array.isArray(rollup)) {
    return classifyPipelineString(rollup.status ?? '')
  }
  // Share rollup rules so pipeline cards cannot diverge from Checks rows.
  const { state } = summarizeProviderChecks(
    rollup.map((job) => {
      const s = job.status?.toLowerCase() ?? ''
      return {
        status: mapPipelineJobStatusToCheckStatus(s),
        conclusion: mapPipelineJobStatusToConclusion(s)
      }
    })
  )
  // The public status type uses neutral for no check results.
  return state === 'none' ? 'neutral' : state
}

type GitLabMRRawForWorkItem = {
  id?: number
  iid?: number
  title: string
  state: string
  draft?: boolean
  web_url?: string
  url?: string
  updated_at?: string
  source_branch?: string
  target_branch?: string
  author?: { username?: string | null } | null
  labels?: ({ name: string } | string)[]
  /** Different source/target projects identify fork MRs whose start points may need special routing. */
  source_project_id?: number
  target_project_id?: number
  has_conflicts?: boolean
  detailed_merge_status?: string
}

export function mapMRToWorkItem(
  data: GitLabMRRawForWorkItem,
  repoId: string,
  projectRef?: GitLabWorkItem['projectRef']
): GitLabWorkItem {
  const labels = (data.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
  const number = data.iid ?? 0
  return {
    // Provider prefix prevents equal GitHub PR and GitLab MR numbers from colliding.
    id: `gitlab-mr-${data.id ?? `${repoId}-${number}`}`,
    type: 'mr',
    number,
    title: data.title,
    state: mapMRState(data.state, data.draft, data.title),
    url: data.web_url ?? data.url ?? '',
    labels,
    updatedAt: data.updated_at ?? '',
    author: data.author?.username ?? null,
    branchName: data.source_branch,
    baseRefName: data.target_branch,
    isCrossRepository:
      data.source_project_id !== undefined &&
      data.target_project_id !== undefined &&
      data.source_project_id !== data.target_project_id,
    repoId,
    ...(data.has_conflicts !== undefined || data.detailed_merge_status !== undefined
      ? { mergeable: deriveMergeable(data) }
      : {}),
    ...(projectRef ? { projectRef } : {})
  }
}

type GitLabIssueRawForWorkItem = {
  id?: number
  iid?: number
  title: string
  state: string
  web_url?: string
  url?: string
  updated_at?: string
  author?: { username?: string | null } | null
  labels?: ({ name: string } | string)[]
}

export function mapIssueToWorkItem(
  data: GitLabIssueRawForWorkItem,
  repoId: string,
  projectRef?: GitLabWorkItem['projectRef']
): GitLabWorkItem {
  const labels = (data.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
  const number = data.iid ?? 0
  const state = data.state?.toLowerCase() === 'opened' ? 'opened' : 'closed'
  return {
    id: `gitlab-issue-${data.id ?? `${repoId}-${number}`}`,
    type: 'issue',
    number,
    title: data.title,
    state,
    url: data.web_url ?? data.url ?? '',
    labels,
    updatedAt: data.updated_at ?? '',
    author: data.author?.username ?? null,
    repoId,
    ...(projectRef ? { projectRef } : {})
  }
}

function classifyPipelineString(status: string): CheckStatus {
  const s = status.toLowerCase()
  if (s === 'success') {
    return 'success'
  }
  if (s === 'failed' || s === 'action_required') {
    return 'failure'
  }
  // Pipeline manual means a required human trigger; report pending because merge can still be blocked.
  if (s === 'manual') {
    return 'pending'
  }
  // Preserve neutral skipped/canceled pipeline tones, independently of job-rollup classification.
  if (
    s === 'created' ||
    s === 'pending' ||
    s === 'running' ||
    s === 'waiting_for_resource' ||
    s === 'preparing' ||
    s === 'scheduled'
  ) {
    return 'pending'
  }
  return 'neutral'
}
