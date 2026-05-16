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
import { getBitbucketRepoSlug } from '../bitbucket/client'
import { getGiteaRepoSlug } from '../gitea/client'
import { createGitHubPullRequest, getRepoSlug } from '../github/client'
import { acquire, ghExecFileAsync, gitExecFileAsync, release } from '../github/gh-utils'
import { resolveDefaultBaseRefViaExec } from '../git/repo'
import { getUpstreamStatus } from '../git/upstream'
import { getProjectSlug } from '../gitlab/client'
import { getHostedReviewForBranch } from './hosted-review'

function stripRefPrefix(ref: string): string {
  return normalizeHostedReviewHeadRef(ref)
}

function branchToTitle(branch: string): string {
  const lastSegment = branch.split('/').filter(Boolean).at(-1) ?? branch
  return lastSegment
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

async function detectHostedReviewProvider(repoPath: string): Promise<HostedReviewProvider> {
  if (await getProjectSlug(repoPath)) {
    return 'gitlab'
  }
  if (await getRepoSlug(repoPath)) {
    return 'github'
  }
  if (await getBitbucketRepoSlug(repoPath)) {
    return 'bitbucket'
  }
  if (await getGiteaRepoSlug(repoPath)) {
    return 'gitea'
  }
  return 'unsupported'
}

async function isGitHubAuthenticated(repoPath: string): Promise<boolean> {
  await acquire()
  try {
    await ghExecFileAsync(['auth', 'status', '--hostname', 'github.com'], { cwd: repoPath })
    return true
  } catch {
    return false
  } finally {
    release()
  }
}

async function getLatestCommitSubject(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(['log', '-1', '--pretty=%s'], { cwd: repoPath })
    const subject = stdout.trim()
    return subject || null
  } catch {
    return null
  }
}

async function getCommitSummaryBody(repoPath: string, base: string | null): Promise<string | null> {
  if (!base) {
    return null
  }
  try {
    const { stdout } = await gitExecFileAsync(
      ['log', '--pretty=format:- %s', '--max-count=20', `${base}..HEAD`],
      { cwd: repoPath }
    )
    const body = stdout.trim()
    return body || null
  } catch {
    return null
  }
}

async function getDefaultBaseRef(repoPath: string): Promise<string | null> {
  return resolveDefaultBaseRefViaExec((argv) => gitExecFileAsync(argv, { cwd: repoPath }))
}

async function getCurrentBranch(repoPath: string): Promise<string> {
  const { stdout } = await gitExecFileAsync(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoPath
  })
  return stripRefPrefix(stdout.trim())
}

async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  const { stdout } = await gitExecFileAsync(['status', '--porcelain'], { cwd: repoPath })
  return stdout.trim().length > 0
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
  input: CreateHostedReviewInput
): Promise<CreateHostedReviewResult | null> {
  const requestedHead = input.head ? stripRefPrefix(input.head).trim() : ''
  const currentBranch = await getCurrentBranch(repoPath)
  if (requestedHead && requestedHead !== currentBranch) {
    return {
      ok: false,
      code: 'validation',
      error: 'Create PR failed: switch back to the selected branch before creating a pull request.'
    }
  }

  try {
    const [dirty, upstreamStatus] = await Promise.all([
      hasUncommittedChanges(repoPath),
      getUpstreamStatus(repoPath)
    ])
    const eligibility = await getHostedReviewCreationEligibility({
      repoPath,
      branch: requestedHead || currentBranch,
      base: normalizeHostedReviewBaseRef(input.base),
      hasUncommittedChanges: dirty,
      hasUpstream: upstreamStatus.hasUpstream,
      ahead: upstreamStatus.ahead,
      behind: upstreamStatus.behind
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
  args: HostedReviewCreationEligibilityArgs
): Promise<HostedReviewCreationEligibility> {
  const branch = stripRefPrefix(args.branch).trim()
  const provider = await detectHostedReviewProvider(args.repoPath)
  const defaultBaseRef = args.base?.trim() || (await getDefaultBaseRef(args.repoPath))
  const baseBranch = defaultBaseRef ? normalizeHostedReviewBaseRef(defaultBaseRef) : null
  const review = await getHostedReviewForBranch({
    repoPath: args.repoPath,
    branch,
    linkedGitHubPR: args.linkedGitHubPR ?? null,
    linkedGitLabMR: args.linkedGitLabMR ?? null,
    linkedBitbucketPR: args.linkedBitbucketPR ?? null,
    linkedGiteaPR: args.linkedGiteaPR ?? null
  })

  const title = (await getLatestCommitSubject(args.repoPath)) ?? branchToTitle(branch)
  const body = await getCommitSummaryBody(args.repoPath, defaultBaseRef ?? null)
  const baseResult = {
    provider,
    review: review ? { number: review.number, url: review.url } : null,
    defaultBaseRef,
    head: branch || null,
    title,
    body
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
  if (!(await isGitHubAuthenticated(args.repoPath))) {
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
  input: CreateHostedReviewInput
): Promise<CreateHostedReviewResult> {
  if (input.provider !== 'github') {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating reviews for this provider is not supported yet.'
    }
  }
  const provider = await detectHostedReviewProvider(repoPath)
  if (provider !== 'github') {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating pull requests requires a GitHub remote.'
    }
  }
  const blocked = await validateCurrentBranchCanCreateReview(repoPath, input)
  if (blocked) {
    return blocked
  }
  return createGitHubPullRequest(repoPath, input)
}
