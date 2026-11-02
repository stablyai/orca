import type { IssueSourcePreference } from '../../shared/repo-types'
import {
  directGiteaApiToken,
  giteaAuthRequiredResult,
  giteaPullIndexArg,
  resolveGiteaMutationRepo,
  type GiteaMutationFailure,
  type GiteaProjectRef
} from './pull-request-mutation-transport'
import type { GiteaRepoRef, LocalGitExecOptions } from './repository-ref'

export type ResolvedGiteaPull = { repo: GiteaRepoRef; indexArg: string }

export function giteaPositiveIntegerText(value: string): string | null {
  const trimmed = value.trim()
  return /^[1-9]\d*$/.test(trimmed) ? trimmed : null
}

function canWrite(repo: GiteaRepoRef): boolean {
  return directGiteaApiToken() !== null || Boolean(repo.loginName)
}

export async function resolveGiteaPullTarget(
  repoPath: string,
  index: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ResolvedGiteaPull | GiteaMutationFailure> {
  const indexArg = giteaPullIndexArg(index)
  if (!indexArg) {
    return { ok: false, error: 'Pull request index must be a positive integer.' }
  }
  const repo = await resolveGiteaMutationRepo(
    repoPath,
    preference,
    connectionId,
    projectRef,
    localGitOptions
  )
  if (!repo) {
    return { ok: false, error: 'No Gitea repository found for this repository.' }
  }
  if (!canWrite(repo)) {
    return giteaAuthRequiredResult()
  }
  return { repo, indexArg }
}

export function isResolvedGiteaPull(
  value: ResolvedGiteaPull | GiteaMutationFailure
): value is ResolvedGiteaPull {
  return 'repo' in value
}
