import type { IssueSourcePreference } from '../../shared/repo-types'
import { invalidateGiteaPullRequestScanForRepo } from './client'
import { requestGiteaJson } from './gitea-json-request'
import type { RawGiteaPullRequest } from './pull-request-mappers'
import {
  directGiteaApiToken,
  encodedGiteaRepoPath,
  giteaAuthRequiredResult,
  giteaPullIndexArg,
  giteaWriteUsesTea,
  resolveGiteaMutationRepo,
  runGiteaTeaCommand,
  teaPullCommand,
  writeGiteaJson,
  type GiteaMutationFailure,
  type GiteaProjectRef
} from './pull-request-mutation-transport'
import type { GiteaRepoRef, LocalGitExecOptions } from './repository-ref'

export type GiteaPRReviewersUpdateResult =
  | { ok: true; reviewers: string[] }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type ResolvedPull = { repo: GiteaRepoRef; indexArg: string }

function canWrite(repo: GiteaRepoRef): boolean {
  return directGiteaApiToken() !== null || Boolean(repo.loginName)
}

function reviewerUsernames(raw: RawGiteaPullRequest): string[] {
  const requested = raw.requested_reviewers
  if (!Array.isArray(requested)) {
    return []
  }
  const names: string[] = []
  for (const entry of requested) {
    if (!isRecord(entry)) {
      continue
    }
    const login = typeof entry.login === 'string' ? entry.login.trim() : ''
    const username = typeof entry.username === 'string' ? entry.username.trim() : ''
    const name = login || username
    if (name) {
      names.push(name)
    }
  }
  return names
}

function uniqueUsernames(values: string[]): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) {
      continue
    }
    seen.add(key)
    names.push(trimmed)
  }
  return names
}

function reviewerDelta(
  current: string[],
  desired: string[]
): { add: string[]; remove: string[]; reviewers: string[] } {
  const wanted = uniqueUsernames(desired)
  const wantedKeys = new Set(wanted.map((name) => name.toLowerCase()))
  const currentNames = uniqueUsernames(current)
  return {
    add: wanted.filter(
      (name) =>
        !currentNames.some((currentName) => currentName.toLowerCase() === name.toLowerCase())
    ),
    remove: currentNames.filter((name) => !wantedKeys.has(name.toLowerCase())),
    reviewers: wanted
  }
}

function isResolvedPull(value: ResolvedPull | GiteaMutationFailure): value is ResolvedPull {
  return 'repo' in value
}

async function resolvePull(
  repoPath: string,
  index: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ResolvedPull | GiteaMutationFailure> {
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

export async function updateGiteaPRReviewers(
  repoPath: string,
  index: number,
  reviewerUsernamesWanted: string[],
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaPRReviewersUpdateResult> {
  const resolved = await resolvePull(
    repoPath,
    index,
    preference,
    connectionId,
    projectRef,
    localGitOptions
  )
  if (!isResolvedPull(resolved)) {
    return resolved
  }
  const { repo, indexArg } = resolved
  const pullPath = `/repos/${encodedGiteaRepoPath(repo)}/pulls/${indexArg}`
  let attempted = false
  try {
    const current = await requestGiteaJson<RawGiteaPullRequest>(repo, pullPath, {}, true)
    if (!current) {
      return { ok: false, error: 'Could not read the pull request reviewers.' }
    }
    const delta = reviewerDelta(reviewerUsernames(current), reviewerUsernamesWanted)
    if (delta.add.length === 0 && delta.remove.length === 0) {
      return { ok: true, reviewers: delta.reviewers }
    }
    attempted = true
    if (giteaWriteUsesTea(repo)) {
      const flags: string[] = []
      if (delta.add.length > 0) {
        flags.push('--add-reviewers', delta.add.join(','))
      }
      if (delta.remove.length > 0) {
        flags.push('--remove-reviewers', delta.remove.join(','))
      }
      const args = teaPullCommand(repo, ['edit', indexArg, ...flags])
      if (!args) {
        return giteaAuthRequiredResult()
      }
      const edited = await runGiteaTeaCommand(args, localGitOptions, repoPath)
      return edited.ok ? { ok: true, reviewers: delta.reviewers } : edited
    }
    if (delta.remove.length > 0) {
      const removed = await writeGiteaJson(repo, `${pullPath}/requested_reviewers`, 'DELETE', {
        reviewers: delta.remove
      })
      if (!removed.ok) {
        return removed
      }
    }
    if (delta.add.length > 0) {
      const added = await writeGiteaJson(repo, `${pullPath}/requested_reviewers`, 'POST', {
        reviewers: delta.add
      })
      if (!added.ok) {
        return added
      }
    }
    return { ok: true, reviewers: delta.reviewers }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (attempted) {
      invalidateGiteaPullRequestScanForRepo(repo)
    }
  }
}
