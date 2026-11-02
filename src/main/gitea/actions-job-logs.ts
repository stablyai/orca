import type { IssueSourcePreference } from '../../shared/repo-types'
import { gitLabJobTraceToLogExcerpt } from '../../shared/gitlab-job-log-excerpt'
import { requestGiteaTextResult } from './client'
import { resolveGiteaIssueSource } from './gitea-issue-source-resolution'
import type { GiteaRepoRef, LocalGitExecOptions } from './repository-ref'
import { repoRefForProject, type GiteaProjectRef } from './work-item-queries'

const JOB_TRACE_TIMEOUT_MS = 60_000

export type GiteaJobTraceResult =
  | { ok: true; trace: string }
  | { ok: false; error: string; errorCode?: string }

export type GiteaRetryJobResult = {
  ok: false
  error: string
  errorCode: 'gitea.jobRetryUnsupported'
}

function repoResource(repo: GiteaRepoRef, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}${suffix}`
}

async function resolveRepo(
  repoPath: string,
  preference: IssueSourcePreference | undefined,
  connectionId: string | null | undefined,
  projectRefOverride: GiteaProjectRef | null | undefined,
  localGitOptions: LocalGitExecOptions
): Promise<GiteaRepoRef | null> {
  if (projectRefOverride) {
    return repoRefForProject(projectRefOverride, connectionId, localGitOptions)
  }
  const resolved = await resolveGiteaIssueSource(
    repoPath,
    preference,
    connectionId,
    localGitOptions
  )
  return resolved.source
}

export async function getGiteaJobTrace(
  repoPath: string,
  jobId: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRefOverride?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaJobTraceResult> {
  const repo = await resolveRepo(
    repoPath,
    preference,
    connectionId,
    projectRefOverride,
    localGitOptions
  )
  if (!repo) {
    return { ok: false, error: 'Could not resolve Gitea repository for this repository' }
  }
  const result = await requestGiteaTextResult(
    repo,
    repoResource(repo, `/actions/jobs/${encodeURIComponent(String(jobId))}/logs`),
    { timeoutMs: JOB_TRACE_TIMEOUT_MS }
  )
  // Queued or canceled-before-start jobs have no log artifact.
  if (result.status === 404) {
    return { ok: true, trace: '' }
  }
  if (result.text === null || result.status < 200 || result.status >= 300) {
    return { ok: false, error: `Failed to load the job log: HTTP ${result.status}` }
  }
  return { ok: true, trace: gitLabJobTraceToLogExcerpt(result.text) }
}

/** Gitea REST v1 and tea do not expose single-job retry. */
export function retryJob(
  repoPath: string,
  jobId: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRefOverride?: GiteaProjectRef | null,
  localGitOptions?: LocalGitExecOptions
): Promise<GiteaRetryJobResult> {
  void repoPath
  void jobId
  void preference
  void connectionId
  void projectRefOverride
  void localGitOptions
  return Promise.resolve({
    ok: false,
    error: 'Retrying a single Gitea Actions job is not supported.',
    errorCode: 'gitea.jobRetryUnsupported'
  })
}
