import type { IssueSourcePreference } from '../../shared/repository/repo-types'
import { invalidateGiteaPullRequestScanForRepo } from './client'
import { requestGiteaJson } from './gitea-json-request'
import type { RawGiteaPullRequest } from './pull-request-mappers'
import {
  directGiteaApiToken,
  encodedGiteaRepoPath,
  giteaAuthRequiredResult,
  giteaPullIndexArg,
  giteaWriteUsesGt,
  resolveGiteaMutationRepo,
  runGiteaGtCommand,
  gtPullCommand,
  writeGiteaJson,
  type GiteaMutationResult,
  type GiteaProjectRef
} from './pull-request-mutation-transport'
import type { GiteaRepoRef, LocalGitExecOptions } from './repository-ref'
import type { GiteaMergeStyle } from '../../shared/gitea-types'

export type { GiteaMergeStyle }

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
    `/repos/${encodedGiteaRepoPath(repo)}/pulls/${indexArg}`
  )
}

async function mutatePullStateViaHttp(
  repo: GiteaRepoRef,
  indexArg: string,
  state: 'closed' | 'open'
): Promise<GiteaMutationResult> {
  return writeGiteaJson(repo, `/repos/${encodedGiteaRepoPath(repo)}/pulls/${indexArg}`, 'PATCH', {
    state
  })
}

async function mutatePullState(
  repoPath: string,
  index: number,
  action: 'close' | 'reopen',
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
  const current = await readPullRequest(repo, indexArg)
  if (current) {
    const shortCircuit = stateShortCircuit(action, current)
    if (shortCircuit) {
      if (shortCircuit.ok) {
        invalidateGiteaPullRequestScanForRepo(repo)
      }
      return shortCircuit
    }
  }

  if (giteaWriteUsesGt(repo)) {
    const args = gtPullCommand(repo, [action, indexArg])
    if (!args) {
      return giteaAuthRequiredResult()
    }
    const result = await runGiteaGtCommand(args, localGitOptions, repoPath)
    if (result.ok) {
      invalidateGiteaPullRequestScanForRepo(repo)
      return { ok: true }
    }
    if (benignStateError(action, result.error)) {
      invalidateGiteaPullRequestScanForRepo(repo)
      return { ok: true }
    }
    return result
  }

  const result = await mutatePullStateViaHttp(
    repo,
    indexArg,
    action === 'close' ? 'closed' : 'open'
  )
  if (result.ok) {
    invalidateGiteaPullRequestScanForRepo(repo)
    return { ok: true }
  }
  if (benignStateError(action, result.error)) {
    invalidateGiteaPullRequestScanForRepo(repo)
    return { ok: true }
  }
  return result
}

export async function closeGiteaPullRequest(
  repoPath: string,
  index: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaMutationResult> {
  return mutatePullState(
    repoPath,
    index,
    'close',
    preference,
    connectionId,
    projectRef,
    localGitOptions
  )
}

export async function reopenGiteaPullRequest(
  repoPath: string,
  index: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaMutationResult> {
  return mutatePullState(
    repoPath,
    index,
    'reopen',
    preference,
    connectionId,
    projectRef,
    localGitOptions
  )
}

function mergeFlags(style?: GiteaMergeStyle): string[] {
  if (style === 'squash') {
    return ['--squash']
  }
  if (style === 'rebase') {
    return ['--rebase']
  }
  if (style === 'rebase-merge') {
    return ['--method', 'rebase-merge']
  }
  return ['--merge']
}

function httpMergeStyle(style?: GiteaMergeStyle): GiteaMergeStyle {
  if (style && MERGE_STYLES.has(style)) {
    return style
  }
  return 'merge'
}

export async function mergeGiteaPullRequest(
  repoPath: string,
  index: number,
  style?: GiteaMergeStyle,
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
  const current = await readPullRequest(repo, indexArg)
  if (current && isMergedPull(current)) {
    invalidateGiteaPullRequestScanForRepo(repo)
    return { ok: true }
  }

  if (giteaWriteUsesGt(repo)) {
    const args = gtPullCommand(repo, ['merge', indexArg, ...mergeFlags(style)])
    if (!args) {
      return giteaAuthRequiredResult()
    }
    const result = await runGiteaGtCommand(args, localGitOptions, repoPath)
    if (result.ok) {
      invalidateGiteaPullRequestScanForRepo(repo)
      return { ok: true }
    }
    const refreshed = await readPullRequest(repo, indexArg)
    if (refreshed && isMergedPull(refreshed)) {
      invalidateGiteaPullRequestScanForRepo(repo)
      return { ok: true }
    }
    return result
  }

  const result = await writeGiteaJson(
    repo,
    `/repos/${encodedGiteaRepoPath(repo)}/pulls/${indexArg}/merge`,
    'POST',
    {
      Do: httpMergeStyle(style)
    }
  )
  if (result.ok) {
    invalidateGiteaPullRequestScanForRepo(repo)
    return { ok: true }
  }
  const refreshed = await readPullRequest(repo, indexArg)
  if (refreshed && isMergedPull(refreshed)) {
    invalidateGiteaPullRequestScanForRepo(repo)
    return { ok: true }
  }
  return result
}

export {
  closeGiteaPullRequest as closeGiteaPR,
  reopenGiteaPullRequest as reopenGiteaPR,
  mergeGiteaPullRequest as mergeGiteaPR
}
