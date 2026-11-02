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
  type GiteaMutationResult,
  type GiteaProjectRef
} from './pull-request-mutation-transport'
import type { GiteaRepoRef, LocalGitExecOptions } from './repository-ref'

export type GiteaMergeStyle = 'merge' | 'squash' | 'rebase' | 'rebase-merge'

const MERGE_STYLES = new Set<GiteaMergeStyle>(['merge', 'squash', 'rebase', 'rebase-merge'])

type ResolvedPull = { repo: GiteaRepoRef; indexArg: string }

function canWrite(repo: GiteaRepoRef): boolean {
  return directGiteaApiToken() !== null || Boolean(repo.loginName)
}

function isMergedPull(raw: RawGiteaPullRequest): boolean {
  return raw.merged === true || raw.has_merged === true
}

function pullState(raw: RawGiteaPullRequest): string {
  return typeof raw.state === 'string' ? raw.state.toLowerCase() : ''
}

function benignStateError(action: 'close' | 'reopen', error: string): boolean {
  const lower = error.toLowerCase()
  if (lower.includes('merged')) {
    return false
  }
  return action === 'close' ? lower.includes('already closed') : lower.includes('already open')
}

function stateShortCircuit(
  action: 'close' | 'reopen',
  raw: RawGiteaPullRequest
): GiteaMutationResult | null {
  if (isMergedPull(raw)) {
    return { ok: false, error: 'Pull request is already merged.' }
  }
  const state = pullState(raw)
  if (action === 'close' && state === 'closed') {
    return { ok: true }
  }
  if (action === 'reopen' && state === 'open') {
    return { ok: true }
  }
  return null
}

async function resolvePull(
  repoPath: string,
  index: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ResolvedPull | GiteaMutationResult> {
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

function isResolvedPull(value: ResolvedPull | GiteaMutationResult): value is ResolvedPull {
  return 'repo' in value
}

async function readPullRequest(
  repo: GiteaRepoRef,
  indexArg: string
): Promise<RawGiteaPullRequest | null> {
  return requestGiteaJson<RawGiteaPullRequest>(
    repo,
    `/repos/${encodedGiteaRepoPath(repo)}/pulls/${indexArg}`,
    {},
    true
  )
}

async function runTeaPull(
  repo: GiteaRepoRef,
  verb: string,
  indexArg: string,
  flags: string[],
  repoPath: string,
  localGitOptions: LocalGitExecOptions,
  timeoutMs?: number
): Promise<GiteaMutationResult> {
  const args = teaPullCommand(repo, [verb, indexArg, ...flags])
  if (!args) {
    return giteaAuthRequiredResult()
  }
  const result = await runGiteaTeaCommand(args, localGitOptions, repoPath, timeoutMs)
  return result.ok ? { ok: true } : result
}

export async function closeGiteaPR(
  repoPath: string,
  index: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaMutationResult> {
  return changePullState(
    'close',
    repoPath,
    index,
    preference,
    connectionId,
    projectRef,
    localGitOptions
  )
}

export async function reopenGiteaPR(
  repoPath: string,
  index: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaMutationResult> {
  return changePullState(
    'reopen',
    repoPath,
    index,
    preference,
    connectionId,
    projectRef,
    localGitOptions
  )
}

async function changePullState(
  action: 'close' | 'reopen',
  repoPath: string,
  index: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaMutationResult> {
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
  let attempted = false
  try {
    const current = await readPullRequest(repo, indexArg)
    if (current) {
      const shortCircuit = stateShortCircuit(action, current)
      if (shortCircuit) {
        return shortCircuit
      }
    }
    attempted = true
    const result = giteaWriteUsesTea(repo)
      ? await runTeaPull(repo, action, indexArg, [], repoPath, localGitOptions)
      : await writeGiteaJson(
          repo,
          `/repos/${encodedGiteaRepoPath(repo)}/pulls/${indexArg}`,
          'PATCH',
          {
            state: action === 'close' ? 'closed' : 'open'
          }
        )
    if (!result.ok && benignStateError(action, result.error)) {
      return { ok: true }
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (benignStateError(action, message)) {
      attempted = true
      return { ok: true }
    }
    return { ok: false, error: message }
  } finally {
    if (attempted) {
      invalidateGiteaPullRequestScanForRepo(repo)
    }
  }
}

export async function mergeGiteaPR(
  repoPath: string,
  index: number,
  method: GiteaMergeStyle = 'merge',
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaMutationResult> {
  if (!MERGE_STYLES.has(method)) {
    return { ok: false, error: 'Merge style must be merge, squash, rebase, or rebase-merge.' }
  }
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
  let attempted = false
  try {
    const current = await readPullRequest(repo, indexArg)
    if (current && isMergedPull(current)) {
      return { ok: false, error: 'Pull request is already merged.' }
    }
    attempted = true
    if (giteaWriteUsesTea(repo)) {
      return runTeaPull(
        repo,
        'merge',
        indexArg,
        ['--style', method],
        repoPath,
        localGitOptions,
        60_000
      )
    }
    return writeGiteaJson(
      repo,
      `/repos/${encodedGiteaRepoPath(repo)}/pulls/${indexArg}/merge`,
      'POST',
      { Do: method }
    )
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (attempted) {
      invalidateGiteaPullRequestScanForRepo(repo)
    }
  }
}
