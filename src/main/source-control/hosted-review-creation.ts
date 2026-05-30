/* eslint-disable max-lines -- Why: provider detection, eligibility, and creation
   preflight share one boundary so renderer and main-process gating cannot drift. */
import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult,
  HostedReviewCreationBlockedReason,
  HostedReviewCreationEligibility,
  HostedReviewCreationEligibilityArgs,
  HostedReviewProvider
} from '../../shared/hosted-review'
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../shared/hosted-review-refs'
import { getAzureDevOpsRepoSlug } from '../azure-devops/client'
import { getBitbucketRepoSlug } from '../bitbucket/client'
import { getGiteaRepoSlug } from '../gitea/client'
import { createGitHubPullRequest, getRepoSlug } from '../github/client'
import { acquire, ghExecFileAsync, gitExecFileAsync, release } from '../github/gh-utils'
import { isNoUpstreamError, normalizeGitErrorMessage } from '../../shared/git-remote-error'
import type { GitUpstreamStatus } from '../../shared/types'
import { gitOptionalLocksDisabledEnv } from '../git/runner'
import { resolveDefaultBaseRefViaExec } from '../git/repo'
import { getUpstreamStatus } from '../git/upstream'
import { getProjectSlug } from '../gitlab/client'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { getHostedReviewForBranch } from './hosted-review'

type HostedReviewCreationEligibilityInput = HostedReviewCreationEligibilityArgs & {
  connectionId?: string | null
}

function stripRefPrefix(ref: string): string {
  return normalizeHostedReviewHeadRef(ref)
}

async function detectHostedReviewProvider(
  repoPath: string,
  connectionId?: string | null
): Promise<HostedReviewProvider> {
  if (await getProjectSlug(repoPath, connectionId)) {
    return 'gitlab'
  }
  if (await getRepoSlug(repoPath, connectionId)) {
    return 'github'
  }
  if (await getBitbucketRepoSlug(repoPath, connectionId)) {
    return 'bitbucket'
  }
  if (await getAzureDevOpsRepoSlug(repoPath, connectionId)) {
    return 'azure-devops'
  }
  if (await getGiteaRepoSlug(repoPath, connectionId)) {
    return 'gitea'
  }
  return 'unsupported'
}

async function isGitHubAuthenticated(
  repoPath: string,
  connectionId?: string | null
): Promise<boolean> {
  await acquire()
  try {
    await ghExecFileAsync(
      ['auth', 'status', '--hostname', 'github.com'],
      connectionId ? {} : { cwd: repoPath }
    )
    return true
  } catch {
    return false
  } finally {
    release()
  }
}

async function runGitForHostedReview(
  repoPath: string,
  args: string[],
  connectionId?: string | null
): Promise<{ stdout: string; stderr?: string }> {
  if (connectionId) {
    const provider = getSshGitProvider(connectionId)
    if (!provider) {
      throw new Error(
        'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
      )
    }
    return provider.exec(args, repoPath)
  }
  return gitExecFileAsync(args, { cwd: repoPath })
}

async function getDefaultBaseRef(
  repoPath: string,
  connectionId?: string | null
): Promise<string | null> {
  return resolveDefaultBaseRefViaExec((argv) => runGitForHostedReview(repoPath, argv, connectionId))
}

async function getCurrentBranch(repoPath: string, connectionId?: string | null): Promise<string> {
  const { stdout } = await runGitForHostedReview(
    repoPath,
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    connectionId
  )
  return stripRefPrefix(stdout.trim())
}

async function hasUncommittedChanges(
  repoPath: string,
  connectionId?: string | null
): Promise<boolean> {
  if (connectionId) {
    const provider = getSshGitProvider(connectionId)
    if (!provider) {
      throw new Error(
        'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
      )
    }
    // Why: the relay intentionally restricts generic git.exec. Use the
    // structured status RPC for SSH dirty checks instead of raw `git status`.
    return (await provider.getStatus(repoPath)).entries.length > 0
  }
  const { stdout } = await gitExecFileAsync(['status', '--porcelain'], {
    cwd: repoPath,
    // Why: create-PR validation should not take Git's optional index lock while
    // the user may be running fetch/pull/rebase from a terminal.
    env: gitOptionalLocksDisabledEnv()
  })
  return stdout.trim().length > 0
}

async function getHostedReviewUpstreamStatus(
  repoPath: string,
  connectionId?: string | null
): Promise<GitUpstreamStatus> {
  if (!connectionId) {
    return getUpstreamStatus(repoPath)
  }
  const provider = getSshGitProvider(connectionId)
  if (!provider) {
    throw new Error('Remote connection dropped. Click Reconnect on the SSH target before retrying.')
  }
  try {
    // Why: SSH exposes upstream divergence through a dedicated relay RPC;
    // generic git.exec intentionally does not allow rev-list/status plumbing.
    return await provider.getUpstreamStatus(repoPath)
  } catch (error) {
    if (isNoUpstreamError(error)) {
      return { hasUpstream: false, ahead: 0, behind: 0 }
    }
    throw new Error(normalizeGitErrorMessage(error, 'upstream'))
  }
}

const blockedCreateResultByReason = {
  auth_required: {
    ok: false,
    code: 'auth_required',
    error:
      'Create PR failed: GitHub is not authenticated. Next step: run gh auth login in this environment.'
  },
  unsupported_provider: {
    ok: false,
    code: 'unsupported_provider',
    error: 'Creating pull requests requires a GitHub remote.'
  },
  dirty: {
    ok: false,
    code: 'validation',
    error: 'Create PR failed: commit or discard local changes before creating a pull request.'
  },
  detached_head: {
    ok: false,
    code: 'validation',
    error: 'Create PR failed: switch to a branch before creating a pull request.'
  },
  default_branch: {
    ok: false,
    code: 'validation',
    error: 'Create PR failed: choose a feature branch before creating a pull request.'
  },
  no_upstream: {
    ok: false,
    code: 'validation',
    error: 'Create PR failed: publish this branch before creating a pull request.'
  },
  needs_push: {
    ok: false,
    code: 'validation',
    error: 'Create PR failed: push this branch before creating a pull request.'
  },
  needs_sync: {
    ok: false,
    code: 'validation',
    error: 'Create PR failed: sync this branch before creating a pull request.'
  },
  fork_head_unsupported: {
    ok: false,
    code: 'validation',
    error: 'Create PR failed: refresh source control status and try again.'
  }
} satisfies Partial<
  Record<NonNullable<HostedReviewCreationBlockedReason>, CreateHostedReviewResult>
>

function blockedEligibilityToCreateResult(
  eligibility: HostedReviewCreationEligibility
): CreateHostedReviewResult | null {
  if (eligibility.canCreate) {
    return null
  }
  if (eligibility.review?.url) {
    return {
      ok: false,
      code: 'already_exists',
      error: 'A pull request already exists for this branch.',
      existingReview: eligibility.review
    }
  }
  if (eligibility.blockedReason) {
    return blockedCreateResultByReason[eligibility.blockedReason] ?? null
  }
  return {
    ok: false,
    code: 'validation',
    error: 'Create PR failed: refresh source control status and try again.'
  }
}

async function validateCurrentBranchCanCreateReview(
  repoPath: string,
  connectionId: string | null | undefined,
  input: CreateHostedReviewInput
): Promise<CreateHostedReviewResult | null> {
  const requestedHead = input.head ? stripRefPrefix(input.head).trim() : ''
  const currentBranch = await getCurrentBranch(repoPath, connectionId)
  if (requestedHead && requestedHead !== currentBranch) {
    return {
      ok: false,
      code: 'validation',
      error: 'Create PR failed: switch back to the selected branch before creating a pull request.'
    }
  }

  try {
    const [dirty, upstreamStatus] = await Promise.all([
      hasUncommittedChanges(repoPath, connectionId),
      getHostedReviewUpstreamStatus(repoPath, connectionId)
    ])
    const eligibility = await getHostedReviewCreationEligibility({
      repoPath,
      branch: requestedHead || currentBranch,
      base: normalizeHostedReviewBaseRef(input.base),
      hasUncommittedChanges: dirty,
      hasUpstream: upstreamStatus.hasUpstream,
      ahead: upstreamStatus.ahead,
      behind: upstreamStatus.behind,
      connectionId
    })
    // Why: renderer eligibility can be stale by submit time; the main process
    // is the last chance to avoid creating a PR from an out-of-date remote head.
    return blockedEligibilityToCreateResult(eligibility)
  } catch (error) {
    console.warn('Hosted review creation preflight failed:', error)
    return {
      ok: false,
      code: 'validation',
      error:
        'Create PR failed: could not verify branch status. Refresh source control and try again.'
    }
  }
}

export async function getHostedReviewCreationEligibility(
  args: HostedReviewCreationEligibilityInput
): Promise<HostedReviewCreationEligibility> {
  const branch = stripRefPrefix(args.branch).trim()
  const provider = await detectHostedReviewProvider(args.repoPath, args.connectionId)
  const defaultBaseRef =
    args.base?.trim() || (await getDefaultBaseRef(args.repoPath, args.connectionId))
  const baseBranch = defaultBaseRef ? normalizeHostedReviewBaseRef(defaultBaseRef) : null
  const review = await getHostedReviewForBranch({
    repoPath: args.repoPath,
    branch,
    linkedGitHubPR: args.linkedGitHubPR ?? null,
    fallbackGitHubPR: args.linkedGitHubPR == null ? (args.fallbackGitHubPR ?? null) : null,
    linkedGitLabMR: args.linkedGitLabMR ?? null,
    linkedBitbucketPR: args.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: args.linkedGiteaPR ?? null,
    connectionId: args.connectionId ?? null
  })

  const baseResult = {
    provider,
    review: review ? { number: review.number, url: review.url } : null,
    defaultBaseRef,
    head: branch || null
  }

  if (!branch || branch === 'HEAD') {
    return { ...baseResult, canCreate: false, blockedReason: 'detached_head', nextAction: null }
  }
  if (review) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'existing_review',
      nextAction: 'open_existing_review'
    }
  }
  if (provider !== 'github') {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'unsupported_provider',
      nextAction: null
    }
  }
  if (baseBranch && branch.toLowerCase() === baseBranch.toLowerCase()) {
    return { ...baseResult, canCreate: false, blockedReason: 'default_branch', nextAction: null }
  }
  if (args.hasUncommittedChanges) {
    return { ...baseResult, canCreate: false, blockedReason: 'dirty', nextAction: 'commit' }
  }
  if (args.hasUpstream === false) {
    return { ...baseResult, canCreate: false, blockedReason: 'no_upstream', nextAction: 'publish' }
  }
  if (args.hasUpstream !== true) {
    return { ...baseResult, canCreate: false, blockedReason: null, nextAction: null }
  }
  if ((args.behind ?? 0) > 0) {
    return { ...baseResult, canCreate: false, blockedReason: 'needs_sync', nextAction: 'sync' }
  }
  if (!(await isGitHubAuthenticated(args.repoPath, args.connectionId))) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'auth_required',
      nextAction: 'authenticate'
    }
  }
  if ((args.ahead ?? 0) > 0) {
    return { ...baseResult, canCreate: false, blockedReason: 'needs_push', nextAction: 'push' }
  }
  return { ...baseResult, canCreate: Boolean(baseBranch), blockedReason: null, nextAction: null }
}

export async function createHostedReview(
  repoPath: string,
  input: CreateHostedReviewInput,
  connectionId?: string | null
): Promise<CreateHostedReviewResult> {
  if (input.provider !== 'github') {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating reviews for this provider is not supported yet.'
    }
  }
  const provider = await detectHostedReviewProvider(repoPath, connectionId)
  if (provider !== 'github') {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating pull requests requires a GitHub remote.'
    }
  }
  const blocked = await validateCurrentBranchCanCreateReview(repoPath, connectionId, input)
  if (blocked) {
    return blocked
  }
  return createGitHubPullRequest(repoPath, input, connectionId)
}
