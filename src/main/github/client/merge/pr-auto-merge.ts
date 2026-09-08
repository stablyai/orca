import type { GitHubPRMergeMethod } from '../../../../shared/github/pull-request-types'
import {
  ghExecFileAsync,
  acquire,
  release,
  classifyGhError,
  type LocalGitExecOptions
} from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { githubPRStackExecutionScope, type GhExecOptions } from './../github-exec-scope'
import { detectRepositoryMergeMetadata } from './../detect/repository-merge-metadata'
import { getRestPRByNumber } from './../lookup/pr-number-lookup'
export const PR_AUTO_MERGE_IDENTITY_JSON_FIELDS = 'id,headRefOid,baseRefName'

export const GITHUB_AUTO_MERGE_METHODS: Record<GitHubPRMergeMethod, 'MERGE' | 'SQUASH' | 'REBASE'> =
  {
    merge: 'MERGE',
    squash: 'SQUASH',
    rebase: 'REBASE'
  }

// Why: GitHub rejects auto-merge on an already-mergeable PR ("clean status"); surface an actionable message instead of the raw error.
export function classifySetAutoMergeError(message: string): string {
  if (/in clean status/i.test(message)) {
    return 'This pull request can already be merged. Use Merge instead of auto-merge.'
  }
  return classifyGhError(message).message
}

export type PRAutoMergeIdentity = {
  id?: string
  headRefOid?: string
  baseRefName?: string
}

export async function getPRAutoMergeIdentity(
  prNumber: number,
  ownerRepo: GitHubApiRepository | null,
  ghOptions: GhExecOptions
): Promise<PRAutoMergeIdentity | null> {
  const args = ['pr', 'view', String(prNumber), '--json', PR_AUTO_MERGE_IDENTITY_JSON_FIELDS]
  if (ownerRepo) {
    args.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
  }
  const { stdout } = await ghExecFileAsync(args, ghOptions)
  const data = JSON.parse(stdout) as PRAutoMergeIdentity
  return {
    id: typeof data.id === 'string' ? data.id : undefined,
    headRefOid: typeof data.headRefOid === 'string' ? data.headRefOid : undefined,
    baseRefName: typeof data.baseRefName === 'string' ? data.baseRefName : undefined
  }
}

export async function runPRAutoMergeCommand(
  prNumber: number,
  method: GitHubPRMergeMethod,
  ownerRepo: GitHubApiRepository | null,
  ghOptions: GhExecOptions
): Promise<void> {
  const args = ['pr', 'merge', String(prNumber), '--auto', `--${method}`]
  if (ownerRepo) {
    args.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
  }
  await ghExecFileAsync(args, {
    ...ghOptions,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' }
  })
}

export async function shouldUseMergeQueueAutoMerge(
  pr: PRAutoMergeIdentity,
  ownerRepo: GitHubApiRepository | null,
  ghOptions: GhExecOptions,
  executionScope?: string
): Promise<boolean> {
  if (!ownerRepo || !pr.baseRefName) {
    return false
  }
  const mergeMetadata = await detectRepositoryMergeMetadata(
    ownerRepo,
    pr.baseRefName,
    ghOptions,
    executionScope
  )
  return mergeMetadata.mergeQueueRequired === true
}

export async function enablePRAutoMerge(
  prNumber: number,
  method: GitHubPRMergeMethod,
  ownerRepo: GitHubApiRepository | null,
  ghOptions: GhExecOptions,
  executionScope?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (ownerRepo) {
    try {
      const restData = await getRestPRByNumber(ownerRepo, prNumber, ghOptions)
      if (restData.stack) {
        return {
          ok: false,
          error: 'GitHub does not support auto-merge for stacked pull requests.'
        }
      }
    } catch {
      // GitHub remains authoritative when stack metadata cannot be read.
    }
  }
  const pr = await getPRAutoMergeIdentity(prNumber, ownerRepo, ghOptions)
  if (!pr?.id) {
    return { ok: false, error: 'Could not resolve GitHub pull request ID' }
  }
  const useMergeQueue = await shouldUseMergeQueueAutoMerge(pr, ownerRepo, ghOptions, executionScope)
  if (useMergeQueue) {
    await runPRAutoMergeCommand(prNumber, method, ownerRepo, ghOptions)
    return { ok: true }
  }
  const query = `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!, $expectedHeadOid: GitObjectID) {
    enablePullRequestAutoMerge(input: {
      pullRequestId: $pullRequestId,
      mergeMethod: $mergeMethod,
      expectedHeadOid: $expectedHeadOid
    }) {
      pullRequest { id }
    }
  }`
  const args = [
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-f',
    `pullRequestId=${pr.id}`,
    '-f',
    `mergeMethod=${GITHUB_AUTO_MERGE_METHODS[method]}`
  ]
  if (pr.headRefOid) {
    args.push('-f', `expectedHeadOid=${pr.headRefOid}`)
  }
  // Why: `gh pr merge --auto` can merge immediately; this mutation only creates the auto-merge request, letting branch requirements gate it.
  await ghExecFileAsync(args, {
    ...ghOptions,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' }
  })
  return { ok: true }
}

export async function setPRAutoMerge(
  repoPath: string,
  prNumber: number,
  enabled: boolean,
  method: GitHubPRMergeMethod = 'squash',
  connectionId?: string | null,
  prRepo?: GitHubApiRepository | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    prRepo,
    connectionId,
    localGitOptions
  )
  if (!ownerRepo) {
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }
  await acquire()
  try {
    if (enabled) {
      return await enablePRAutoMerge(
        prNumber,
        method,
        ownerRepo,
        ghOptions,
        githubPRStackExecutionScope(connectionId, localGitOptions)
      )
    }
    const args = ['pr', 'merge', String(prNumber), '--disable-auto']
    if (ownerRepo) {
      args.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
    }
    await ghExecFileAsync(args, {
      ...ghOptions,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: classifySetAutoMergeError(message) }
  } finally {
    release()
  }
}
