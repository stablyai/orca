import type {
  CheckStatus,
  GitLabIssueInfo,
  GitLabWorkItem,
  MRCheckDetail,
  MRInfo,
  MRState
} from '../../shared/types'

// ── Pipeline job mapping (GitLab REST `/pipelines/:id/jobs`) ────────
// Why: GitLab pipeline jobs roughly map to GitHub check-runs, but use a
// single `status` field that combines lifecycle + outcome. We split it
// into PRCheckDetail's status + conclusion shape so the renderer can
// share a row with the GitHub side.

export function mapPipelineJobStatusToCheckStatus(status: string): MRCheckDetail['status'] {
  const s = status?.toLowerCase()
  if (s === 'created' || s === 'pending' || s === 'waiting_for_resource' || s === 'preparing') {
    return 'queued'
  }
  if (s === 'running') {
    return 'in_progress'
  }
  return 'completed'
}

export function mapPipelineJobStatusToConclusion(status: string): MRCheckDetail['conclusion'] {
  const s = status?.toLowerCase()
  if (s === 'success') {
    return 'success'
  }
  if (s === 'failed') {
    return 'failure'
  }
  if (s === 'canceled' || s === 'canceling') {
    return 'cancelled'
  }
  if (s === 'skipped') {
    return 'skipped'
  }
  // Why: 'manual' jobs require user trigger and never auto-complete; we
  // surface them as neutral rather than pending so they don't stall the
  // top-level rollup at "pending" forever.
  if (s === 'manual') {
    return 'neutral'
  }
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
  return null
}

// ── MR state mapping ────────────────────────────────────────────────
// Why: glab returns the API state directly. Apply the draft flag (or a
// `Draft:` title prefix, which is GitLab's title-based draft convention)
// so the UI sees a single discriminator.

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
  // Why: GitLab supports drafts via either a boolean field (newer API) or
  // a `Draft:` / `WIP:` title prefix (legacy). Either signal counts.
  if (isDraft || (title && /^(draft|wip):\s*/i.test(title))) {
    return 'draft'
  }
  return 'opened'
}

// ── Issue mapping ────────────────────────────────────────────────────
// glab issue view returns: { iid, title, state, web_url, labels: [{name}] | string[] }
// `state` is already lowercase 'opened' | 'closed' so the mapping is
// mostly a normalization shim.

export function mapGitLabIssueInfo(data: {
  iid?: number
  number?: number
  title: string
  state: string
  web_url?: string
  url?: string
  labels?: { name: string }[] | string[]
  description?: string | null
  author?: { username?: string | null; avatar_url?: string | null } | null
}): GitLabIssueInfo {
  // Why: glab CLI flips between exposing `iid` and `number` depending on
  // command + --output flag combination. Accept both.
  const number = data.iid ?? data.number ?? 0
  const labels = (data.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
  return {
    number,
    title: data.title,
    state: data.state?.toLowerCase() === 'opened' ? 'opened' : 'closed',
    url: data.web_url ?? data.url ?? '',
    labels,
    // Why: same description / author optional plumbing as mapMRInfo —
    // list payloads strip these so callers can tell "absent" from "blank".
    ...(typeof data.description === 'string' ? { description: data.description } : {}),
    ...(data.author?.username ? { author: data.author.username } : {}),
    ...(data.author?.avatar_url ? { authorAvatarUrl: data.author.avatar_url } : {})
  }
}

// ── MR info mapping ──────────────────────────────────────────────────
// Why: parallel to mapPRState's role for GitHub. glab returns iid +
// web_url + state + draft + sha + has_conflicts.

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
  description?: string | null
  author?: { username?: string | null; avatar_url?: string | null } | null
}

export function mapMRInfo(data: GitLabMRRaw, pipelineStatus: CheckStatus): MRInfo {
  return {
    number: data.iid ?? data.number ?? 0,
    title: data.title,
    state: mapMRState(data.state, data.draft, data.title),
    url: data.web_url ?? data.url ?? '',
    pipelineStatus,
    updatedAt: data.updated_at ?? data.updatedAt ?? '',
    mergeable: deriveMergeable(data),
    headSha: data.sha,
    // Why: detail-endpoint payloads include `description`; list endpoints
    // strip it. Pass through what's present rather than coercing missing
    // values to '' so downstream UIs can distinguish "no body authored"
    // from "this came from a list and the body is unknown".
    ...(typeof data.description === 'string' ? { description: data.description } : {}),
    ...(data.author?.username ? { author: data.author.username } : {}),
    ...(data.author?.avatar_url ? { authorAvatarUrl: data.author.avatar_url } : {})
  }
}

function deriveMergeable(data: GitLabMRRaw): MRInfo['mergeable'] {
  if (data.has_conflicts === true) {
    return 'CONFLICTING'
  }
  // Why: detailed_merge_status is GitLab's richest signal. Treat
  // 'mergeable' as the only positive value — every other state
  // (checking, ci_must_pass, draft_status, etc.) is an unknown from the
  // user's POV because it may flip without warning.
  if (data.detailed_merge_status === 'mergeable') {
    return 'MERGEABLE'
  }
  if (data.detailed_merge_status === 'broken_status' || data.detailed_merge_status === 'conflict') {
    return 'CONFLICTING'
  }
  return 'UNKNOWN'
}

// ── Pipeline rollup (parallel to GitHub deriveCheckStatus) ──────────
// Why: GitLab returns a single pipeline `status` for the head commit; we
// can also receive an array of jobs and roll them up the same way the
// GitHub side does. Accept either shape.

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
  if (rollup.length === 0) {
    return 'neutral'
  }
  let hasFailure = false
  let hasPending = false
  for (const job of rollup) {
    const s = job.status?.toLowerCase()
    if (s === 'failed') {
      hasFailure = true
    } else if (
      s === 'created' ||
      s === 'pending' ||
      s === 'running' ||
      s === 'waiting_for_resource' ||
      s === 'preparing' ||
      s === 'scheduled'
    ) {
      hasPending = true
    }
  }
  if (hasFailure) {
    return 'failure'
  }
  if (hasPending) {
    return 'pending'
  }
  return 'success'
}

// ── Raw → GitLabWorkItem mapping ────────────────────────────────────
// Why: list endpoints return MR / issue records; the picker consumes a
// unified GitLabWorkItem. Mirrors the GitHub side where MainWorkItem is
// produced from PR / issue REST + GraphQL responses.

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
  /** Why: source_project_id !== target_project_id signals a fork MR.
   *  GitLab list endpoints include both — the picker uses this flag the
   *  same way GitHub's isCrossRepository disables fork-MR start points
   *  when the workspace flow can't safely resolve the head. */
  source_project_id?: number
  target_project_id?: number
}

export function mapMRToWorkItem(data: GitLabMRRawForWorkItem, repoId: string): GitLabWorkItem {
  const labels = (data.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
  const number = data.iid ?? 0
  return {
    // Why: id needs to be unique across providers in the picker. Prefix
    // 'gitlab-mr-' so a GitHub PR #5 and a GitLab MR !5 don't collide.
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
    repoId
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
  repoId: string
): GitLabWorkItem {
  const labels = (data.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
  const number = data.iid ?? 0
  // Issues only ever resolve to 'opened' or 'closed' (issue state space is
  // narrower than MRs); coerce defensively without inventing values.
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
    repoId
  }
}

function classifyPipelineString(status: string): CheckStatus {
  const s = status.toLowerCase()
  if (s === 'success') {
    return 'success'
  }
  if (s === 'failed') {
    return 'failure'
  }
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
