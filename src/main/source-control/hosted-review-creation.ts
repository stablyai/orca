/* eslint-disable max-lines -- Why: detection, eligibility, and creation preflight share one boundary so gating can't drift. */
import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult,
  HostedReviewCreationBlockedReason,
  HostedReviewCreationEligibility,
  HostedReviewCreationEligibilityArgs,
  HostedReviewLookupOutcome,
  HostedReviewProvider
} from '../../shared/hosted-review'
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../shared/hosted-review-refs'
import {
  supportsHostedReviewCreation,
  type HostedReviewCreationProvider
} from '../../shared/hosted-review-creation-providers'
import { isAzureDevOpsReviewCreationAuthenticated } from '../azure-devops/pull-request-creation'
import { isGiteaReviewCreationAuthenticated } from '../gitea/pull-request-creation'
import { getEnterpriseGitHubRepoSlug } from '../github/github-enterprise-repository'
import { acquire, ghExecFileAsync, gitExecFileAsync, release } from '../github/gh-utils'
import { isNoUpstreamError, normalizeGitErrorMessage } from '../../shared/git-remote-error'
import type { GitUpstreamStatus } from '../../shared/types'
import { gitOptionalLocksDisabledEnv } from '../git/runner'
import { resolveDefaultBaseRefViaExec } from '../git/repo'
import { getUpstreamStatus } from '../git/upstream'
import { getProjectSlug } from '../gitlab/client'
import {
  acquire as acquireGlab,
  glabExecFileAsync,
  glabRepoExecOptions,
  release as releaseGlab
} from '../gitlab/gl-utils'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { detectHostedReviewProvider, getForgeProviderForRepository } from './forge-provider'
import { getHostedReviewForBranch } from './hosted-review'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from './hosted-review-git-options'

type HostedReviewCreationEligibilityInput = HostedReviewCreationEligibilityArgs & {
  connectionId?: string | null
  // Why: only the create-time preflight sets this; the renderer's probe leaves it unset to auto-correct a local-only parent.
  enforceBaseOnRemote?: boolean
} & HostedReviewExecutionOptions

function stripRefPrefix(ref: string): string {
  return normalizeHostedReviewHeadRef(ref)
}

function hostedReviewExecutionContext(
  options: HostedReviewExecutionOptions = {}
): HostedReviewExecutionOptions {
  const localGitExecOptions = getHostedReviewLocalGitOptions(options)
  return Object.keys(localGitExecOptions).length > 0 ? { localGitExecOptions } : {}
}

async function isGitHubAuthenticated(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<boolean> {
  // Why: a non-null enterprise slug already means gh is authenticated there, so skip a redundant probe (#8312).
  if (await getEnterpriseGitHubRepoSlug(repoPath, connectionId, options)) {
    return true
  }
  await acquire()
  try {
    // Why: `host` scopes any rate-limit breaker trip to github.com — the host
    // this probe actually targets — instead of a GH_HOST-derived scope.
    await ghExecFileAsync(
      ['auth', 'status', '--hostname', 'github.com'],
      connectionId
        ? { host: 'github.com' }
        : { cwd: repoPath, ...getHostedReviewLocalGitOptions(options), host: 'github.com' }
    )
    return true
  } catch {
    return false
  } finally {
    release()
  }
}

async function isGitLabAuthenticated(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<boolean> {
  const projectRef = await getProjectSlug(repoPath, connectionId, options)
  if (!projectRef) {
    return false
  }
  await acquireGlab()
  try {
    await glabExecFileAsync(['auth', 'status', '--hostname', projectRef.host], {
      ...glabRepoExecOptions(repoPath, connectionId),
      ...(connectionId ? {} : getHostedReviewLocalGitOptions(options))
    })
    return true
  } catch {
    return false
  } finally {
    releaseGlab()
  }
}

async function runGitForHostedReview(
  repoPath: string,
  args: string[],
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
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
  return gitExecFileAsync(args, { cwd: repoPath, ...getHostedReviewLocalGitOptions(options) })
}

async function getDefaultBaseRef(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<string | null> {
  return resolveDefaultBaseRefViaExec((argv) =>
    runGitForHostedReview(repoPath, argv, connectionId, options)
  )
}

/**
 * Whether the candidate base resolves to a remote-tracking branch on the
 * executing host.
 *
 * Why: matches under *any* remote (not just origin) and reads the local tracking snapshot, not the live remote.
 */
async function baseRefExistsOnRemote(
  candidate: string,
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<boolean> {
  const base = normalizeHostedReviewBaseRef(candidate).trim()
  if (!base) {
    return false
  }
  const run = (argv: string[]): Promise<{ stdout: string }> =>
    runGitForHostedReview(repoPath, argv, connectionId, options)

  const patterns = [`refs/remotes/*/${base}`]
  // `*` does not cross `/`, so a remote-qualified candidate (e.g. `fork/main`) needs its exact tracking ref too.
  if (base.includes('/')) {
    patterns.push(`refs/remotes/${base}`)
  }

  try {
    // for-each-ref exits 0 on no match: empty means absent, a thrown error means transport failure (preserve the candidate).
    const { stdout } = await run(['for-each-ref', '--count=1', '--format=%(refname)', ...patterns])
    return stdout.trim().length > 0
  } catch {
    return true
  }
}

async function getCurrentBranch(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<string> {
  const { stdout } = await runGitForHostedReview(
    repoPath,
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    connectionId,
    options
  )
  return stripRefPrefix(stdout.trim())
}

async function hasUncommittedChanges(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<boolean> {
  if (connectionId) {
    const provider = getSshGitProvider(connectionId)
    if (!provider) {
      throw new Error(
        'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
      )
    }
    // Why: the relay restricts generic git.exec, so use the structured status RPC for SSH dirty checks.
    return (await provider.getStatus(repoPath)).entries.length > 0
  }
  const { stdout } = await gitExecFileAsync(['status', '--porcelain'], {
    cwd: repoPath,
    ...getHostedReviewLocalGitOptions(options),
    // Why: don't take Git's optional index lock while the user may be running fetch/pull/rebase in a terminal.
    env: gitOptionalLocksDisabledEnv()
  })
  return stdout.trim().length > 0
}

async function getHostedReviewUpstreamStatus(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<GitUpstreamStatus> {
  if (!connectionId) {
    return getUpstreamStatus(repoPath, undefined, getHostedReviewLocalGitOptions(options))
  }
  const provider = getSshGitProvider(connectionId)
  if (!provider) {
    throw new Error('Remote connection dropped. Click Reconnect on the SSH target before retrying.')
  }
  try {
    // Why: the relay blocks generic git.exec, so use its dedicated upstream RPC for SSH divergence.
    return await provider.getUpstreamStatus(repoPath)
  } catch (error) {
    if (isNoUpstreamError(error)) {
      return { hasUpstream: false, ahead: 0, behind: 0 }
    }
    throw new Error(normalizeGitErrorMessage(error, 'upstream'))
  }
}

function reviewCopy(provider: HostedReviewProvider): {
  shortLabel: 'PR' | 'MR'
  reviewLabel: 'pull request' | 'merge request'
  providerName: string
  authInstruction: string
} {
  if (provider === 'gitlab') {
    return {
      shortLabel: 'MR',
      reviewLabel: 'merge request',
      providerName: 'GitLab',
      authInstruction: 'Run glab auth login'
    }
  }
  if (provider === 'azure-devops') {
    return {
      shortLabel: 'PR',
      reviewLabel: 'pull request',
      providerName: 'Azure DevOps',
      authInstruction: 'Set ORCA_AZURE_DEVOPS_TOKEN'
    }
  }
  if (provider === 'gitea') {
    return {
      shortLabel: 'PR',
      reviewLabel: 'pull request',
      providerName: 'Gitea',
      authInstruction: 'Set ORCA_GITEA_TOKEN'
    }
  }
  return {
    shortLabel: 'PR',
    reviewLabel: 'pull request',
    providerName: 'GitHub',
    authInstruction: 'Run gh auth login'
  }
}

async function isProviderAuthenticated(
  provider: HostedReviewCreationProvider,
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<boolean> {
  if (provider === 'gitlab') {
    return isGitLabAuthenticated(repoPath, connectionId, options)
  }
  if (provider === 'azure-devops') {
    return isAzureDevOpsReviewCreationAuthenticated()
  }
  if (provider === 'gitea') {
    return isGiteaReviewCreationAuthenticated()
  }
  return isGitHubAuthenticated(repoPath, connectionId, options)
}

function blockedCreateResultForReason(
  reason: NonNullable<HostedReviewCreationBlockedReason>,
  provider: HostedReviewProvider,
  submittedBase?: string | null
): CreateHostedReviewResult | null {
  const copy = reviewCopy(provider)
  const baseLabel = submittedBase?.trim() ? `"${submittedBase.trim()}" ` : ''
  const blockedCreateResultByReason = {
    auth_required: {
      ok: false,
      code: 'auth_required',
      error: `Create ${copy.shortLabel} failed: ${copy.providerName} is not authenticated. Next step: ${copy.authInstruction} in this environment.`
    },
    unsupported_provider: {
      ok: false,
      code: 'unsupported_provider',
      error: `Creating ${copy.reviewLabel}s requires a ${copy.providerName} remote.`
    },
    dirty: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: commit or discard local changes before creating a ${copy.reviewLabel}.`
    },
    detached_head: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: switch to a branch before creating a ${copy.reviewLabel}.`
    },
    default_branch: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: choose a feature branch before creating a ${copy.reviewLabel}.`
    },
    no_upstream: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: publish this branch before creating a ${copy.reviewLabel}.`
    },
    needs_push: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: push this branch before creating a ${copy.reviewLabel}.`
    },
    needs_sync: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: sync this branch before creating a ${copy.reviewLabel}.`
    },
    fork_head_unsupported: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: refresh source control status and try again.`
    },
    base_not_on_remote: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: the base branch ${baseLabel}hasn't been pushed to the remote. Choose a pushed base or push it first.`
    }
  } satisfies Partial<
    Record<NonNullable<HostedReviewCreationBlockedReason>, CreateHostedReviewResult>
  >
  return blockedCreateResultByReason[reason] ?? null
}

function blockedEligibilityToCreateResult(
  eligibility: HostedReviewCreationEligibility,
  submittedBase?: string | null
): CreateHostedReviewResult | null {
  if (eligibility.canCreate) {
    return null
  }
  if (eligibility.review?.url) {
    const copy = reviewCopy(eligibility.provider)
    return {
      ok: false,
      code: 'already_exists',
      error: `A ${copy.reviewLabel} already exists for this branch.`,
      existingReview: eligibility.review
    }
  }
  if (eligibility.blockedReason) {
    return blockedCreateResultForReason(
      eligibility.blockedReason,
      eligibility.provider,
      submittedBase
    )
  }
  const copy = reviewCopy(eligibility.provider)
  return {
    ok: false,
    code: 'validation',
    error: `Create ${copy.shortLabel} failed: refresh source control status and try again.`
  }
}

async function validateCurrentBranchCanCreateReview(
  repoPath: string,
  connectionId: string | null | undefined,
  input: CreateHostedReviewInput,
  options: HostedReviewExecutionOptions = {}
): Promise<CreateHostedReviewResult | null> {
  const requestedHead = input.head ? stripRefPrefix(input.head).trim() : ''
  const currentBranch = await getCurrentBranch(repoPath, connectionId, options)
  const copy = reviewCopy(input.provider)
  if (requestedHead && requestedHead !== currentBranch) {
    return {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: switch back to the selected branch before creating a ${copy.reviewLabel}.`
    }
  }

  try {
    const [dirty, upstreamStatus] = await Promise.all([
      hasUncommittedChanges(repoPath, connectionId, options),
      getHostedReviewUpstreamStatus(repoPath, connectionId, options)
    ])
    const submittedBase = normalizeHostedReviewBaseRef(input.base)
    const eligibility = await getHostedReviewCreationEligibility({
      repoPath,
      branch: requestedHead || currentBranch,
      base: submittedBase,
      hasUncommittedChanges: dirty,
      hasUpstream: upstreamStatus.hasUpstream,
      ahead: upstreamStatus.ahead,
      behind: upstreamStatus.behind,
      connectionId,
      // Why: last gate before the create, which targets the submitted base verbatim — enforce it exists on the remote.
      enforceBaseOnRemote: true,
      ...options
    })
    // Why: an unavailable lookup might hide a real PR — refuse rather than risk a duplicate (design invariant 8).
    if (eligibility.reviewLookupOutcome === 'unavailable') {
      return {
        ok: false,
        code: 'validation',
        error: `Create ${copy.shortLabel} failed: Orca could not confirm whether this branch already has a ${copy.reviewLabel}. Retry once the ${copy.providerName} lookup succeeds.`
      }
    }
    // Why: renderer eligibility can be stale by submit time; main process is the last gate before an out-of-date create.
    return blockedEligibilityToCreateResult(eligibility, submittedBase)
  } catch (error) {
    console.warn('Hosted review creation preflight failed:', error)
    return {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: could not verify branch status. Refresh source control and try again.`
    }
  }
}

export async function getHostedReviewCreationEligibility(
  args: HostedReviewCreationEligibilityInput
): Promise<HostedReviewCreationEligibility> {
  const branch = stripRefPrefix(args.branch).trim()
  const provider = await detectHostedReviewProvider({
    repoPath: args.repoPath,
    connectionId: args.connectionId,
    ...hostedReviewExecutionContext(args)
  })
  // Why: the base is only a candidate; fall back to repo default so a local-only parent targets a remote-resolvable ref.
  const candidateBase = args.base?.trim() || null
  const candidateBaseOnRemote =
    candidateBase != null &&
    (await baseRefExistsOnRemote(candidateBase, args.repoPath, args.connectionId, args))
  let defaultBaseRef: string | null
  if (candidateBase && candidateBaseOnRemote) {
    defaultBaseRef = candidateBase
  } else {
    const repoDefaultBaseRef = await getDefaultBaseRef(args.repoPath, args.connectionId, args)
    defaultBaseRef = repoDefaultBaseRef ?? candidateBase
  }
  const baseBranch = defaultBaseRef ? normalizeHostedReviewBaseRef(defaultBaseRef) : null
  let review: Awaited<ReturnType<typeof getHostedReviewForBranch>> = null
  // Why: track lookup failure so a swallowed error isn't mistaken for authoritative no-review evidence.
  let lookupFailed = false
  try {
    review = await getHostedReviewForBranch({
      repoPath: args.repoPath,
      branch,
      linkedGitHubPR: args.linkedGitHubPR ?? null,
      fallbackGitHubPR: args.linkedGitHubPR == null ? (args.fallbackGitHubPR ?? null) : null,
      linkedGitLabMR: args.linkedGitLabMR ?? null,
      linkedBitbucketPR: args.linkedBitbucketPR ?? null,
      linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
      linkedGiteaPR: args.linkedGiteaPR ?? null,
      connectionId: args.connectionId ?? null,
      ...hostedReviewExecutionContext(args)
    })
  } catch (error) {
    // Why: a failed lookup might hide a real PR, so record unavailable and fall through rather than rethrow.
    lookupFailed = true
    console.warn('Hosted review lookup failed; treating existing-review as unavailable:', error)
  }

  const reviewLookupOutcome: HostedReviewLookupOutcome = review
    ? 'found'
    : lookupFailed
      ? 'unavailable'
      : 'not_found'
  const baseResult = {
    provider,
    review: review ? { number: review.number, url: review.url } : null,
    reviewLookupOutcome,
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
  if (!supportsHostedReviewCreation(provider)) {
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
  const authenticated = await isProviderAuthenticated(
    provider,
    args.repoPath,
    args.connectionId,
    args
  )
  if (!authenticated) {
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
  // Why: providers target the submitted base verbatim; block a local-only base here with actionable copy.
  if (args.enforceBaseOnRemote && candidateBase && !candidateBaseOnRemote) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'base_not_on_remote',
      nextAction: null
    }
  }
  // Why: a failed lookup leaves review existence unproven, so the happy path must not claim canCreate.
  return {
    ...baseResult,
    canCreate: lookupFailed ? false : Boolean(baseBranch),
    blockedReason: null,
    nextAction: null
  }
}

export async function createHostedReview(
  repoPath: string,
  input: CreateHostedReviewInput,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<CreateHostedReviewResult> {
  if (!supportsHostedReviewCreation(input.provider)) {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating reviews for this provider is not supported yet.'
    }
  }
  const provider = await getForgeProviderForRepository({
    repoPath,
    connectionId,
    ...hostedReviewExecutionContext(options)
  })
  if (provider?.id !== input.provider || !provider.createReview) {
    const copy = reviewCopy(input.provider)
    return {
      ok: false,
      code: 'unsupported_provider',
      error: `Creating ${copy.reviewLabel}s requires a ${copy.providerName} remote.`
    }
  }
  const blocked = await validateCurrentBranchCanCreateReview(repoPath, connectionId, input, options)
  if (blocked) {
    return blocked
  }
  const localGitOptions = getHostedReviewLocalGitOptions(options)
  return Object.keys(localGitOptions).length > 0
    ? provider.createReview(repoPath, input, connectionId, options)
    : provider.createReview(repoPath, input, connectionId)
}
