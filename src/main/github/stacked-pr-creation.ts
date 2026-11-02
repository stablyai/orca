import type { ExecutionHostId } from '../../shared/execution-host'
import { hostedReviewSshConnectionId } from '../source-control/hosted-review-execution-host'
import type {
  CreateStackedHostedReviewInput,
  CreateStackedHostedReviewResult
} from '../../shared/hosted-review'
import { isDefaultGitHubHost } from '../../shared/github/repository-identity-key'
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../shared/hosted-review-refs'
import { acquire, ghExecFileAsync, ghRepoExecOptions, githubRepoContext, release } from './gh-utils'
import {
  getOriginGitHubApiRepository,
  githubHostExecOptions,
  type GitHubApiRepository
} from './github-api-repository'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import {
  parseGitHubStackPullRequests,
  parseGitHubStacks,
  type GitHubStack,
  type GitHubStackPullRequest,
  type NumberedHostedReviewSummary
} from './github-stack-api-responses'
import { stackedReviewFailure } from '../../shared/stacked-hosted-review-failure-copy'

type StackedPullRequestPlan =
  | {
      ok: true
      repository: GitHubApiRepository
      parentReview: GitHubStackPullRequest
      currentReview: GitHubStackPullRequest | null
    }
  | Extract<CreateStackedHostedReviewResult, { ok: false }>

function isStacksUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return message.includes('http 404') || message.includes('feature not supported')
}

function ghOptions(
  repoPath: string,
  repository: GitHubApiRepository,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
) {
  return {
    ...ghRepoExecOptions(
      githubRepoContext(repoPath, connectionId, getHostedReviewLocalGitOptions(options))
    ),
    ...githubHostExecOptions(repository),
    timeout: 60_000
  }
}

async function findOpenPullRequestsForBranch(
  repository: GitHubApiRepository,
  branch: string,
  execOptions: ReturnType<typeof ghOptions>,
  base?: string
): Promise<GitHubStackPullRequest[]> {
  const head = encodeURIComponent(`${repository.owner}:${branch}`)
  const baseQuery = base ? `&base=${encodeURIComponent(base)}` : ''
  const endpoint = `repos/${repository.owner}/${repository.repo}/pulls?head=${head}${baseQuery}&state=open&per_page=2`
  const { stdout } = await ghExecFileAsync(['api', endpoint], execOptions)
  return parseGitHubStackPullRequests(stdout)
}

async function getStacksForPullRequest(
  repository: GitHubApiRepository,
  pullRequestNumber: number,
  execOptions: ReturnType<typeof ghOptions>
): Promise<GitHubStack[]> {
  const endpoint = `repos/${repository.owner}/${repository.repo}/stacks?pull_request=${pullRequestNumber}`
  const { stdout } = await ghExecFileAsync(['api', endpoint], execOptions)
  return parseGitHubStacks(stdout)
}

function validateParentStack(
  parentReview: NumberedHostedReviewSummary,
  stacks: GitHubStack[]
): Extract<CreateStackedHostedReviewResult, { ok: false }> | null {
  if (stacks.length > 1) {
    return stackedReviewFailure('stack_parent_multiple_stacks')
  }
  const stack = stacks[0]
  if (!stack) {
    return null
  }
  if (!stack.open) {
    return stackedReviewFailure('stack_parent_closed')
  }
  if (stack.pull_requests.at(-1)?.number !== parentReview.number) {
    return stackedReviewFailure('stack_parent_not_top')
  }
  return null
}

export async function prepareGitHubStackedPullRequest(
  repoPath: string,
  input: CreateStackedHostedReviewInput,
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {}
): Promise<StackedPullRequestPlan> {
  if (input.provider !== 'github') {
    return stackedReviewFailure('stack_github_only')
  }
  // `gh` runs on this client whatever the host; only the git reads under it are routed.
  const connectionId = hostedReviewSshConnectionId(executionHostId)
  const context = githubRepoContext(repoPath, connectionId, getHostedReviewLocalGitOptions(options))
  const repository = await getOriginGitHubApiRepository(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
  if (!repository || !isDefaultGitHubHost(repository.host)) {
    return stackedReviewFailure('stack_github_com_only')
  }
  const execOptions = {
    ...ghRepoExecOptions(context),
    ...githubHostExecOptions(repository),
    timeout: 60_000
  }
  const base = normalizeHostedReviewBaseRef(input.base).trim()
  const head = input.head ? normalizeHostedReviewHeadRef(input.head).trim() : ''
  if (!base || !head || base.toLowerCase() === head.toLowerCase()) {
    return stackedReviewFailure('stack_same_parent')
  }

  await acquire()
  try {
    const [parentPullRequests, currentPullRequests] = await Promise.all([
      findOpenPullRequestsForBranch(repository, base, execOptions),
      findOpenPullRequestsForBranch(repository, head, execOptions, base)
    ])
    if (parentPullRequests.length === 0) {
      return stackedReviewFailure('stack_parent_without_review', { base })
    }
    if (parentPullRequests.length !== 1) {
      return stackedReviewFailure('stack_parent_ambiguous', { base })
    }
    if (currentPullRequests.length > 1) {
      return stackedReviewFailure('stack_head_ambiguous', { head })
    }
    const parentReview = parentPullRequests[0]
    const currentReview = currentPullRequests[0] ?? null
    const [parentStacks, currentStacks] = await Promise.all([
      getStacksForPullRequest(repository, parentReview.number, execOptions),
      currentReview
        ? getStacksForPullRequest(repository, currentReview.number, execOptions)
        : Promise.resolve([])
    ])
    if (
      currentReview &&
      registeredStackNumber(parentReview, currentReview, parentStacks, currentStacks)
    ) {
      return { ok: true, repository, parentReview, currentReview }
    }
    if (currentStacks.length > 0) {
      return stackedReviewFailure('stack_conflict')
    }
    const parentError = validateParentStack(parentReview, parentStacks)
    return (
      parentError ?? {
        ok: true,
        repository,
        parentReview,
        currentReview
      }
    )
  } catch (error) {
    console.warn('GitHub stack creation preflight failed:', error)
    return isStacksUnavailableError(error)
      ? stackedReviewFailure('stacks_unavailable')
      : stackedReviewFailure('stack_parent_unverified', {}, 'unknown')
  } finally {
    release()
  }
}

function registeredStackNumber(
  parentReview: NumberedHostedReviewSummary,
  currentReview: NumberedHostedReviewSummary,
  parentStacks: GitHubStack[],
  currentStacks: GitHubStack[]
): number | null {
  const parentStack = parentStacks[0]
  const currentStack = currentStacks[0]
  if (!parentStack || !currentStack || parentStack.number !== currentStack.number) {
    return null
  }
  const parentPosition = parentStack.pull_requests.findIndex(
    (pullRequest) => pullRequest.number === parentReview.number
  )
  // A missing parent gives -1; its successor index 0 must not look like an existing pair.
  if (parentPosition === -1) {
    return null
  }
  return parentStack.pull_requests[parentPosition + 1]?.number === currentReview.number
    ? parentStack.number
    : null
}

export async function registerGitHubStackedPullRequest(args: {
  repoPath: string
  repository: GitHubApiRepository
  parentReview: NumberedHostedReviewSummary
  currentReview: NumberedHostedReviewSummary
  executionHostId: ExecutionHostId
  options?: HostedReviewExecutionOptions
}): Promise<CreateStackedHostedReviewResult> {
  const options = args.options ?? {}
  const connectionId = hostedReviewSshConnectionId(args.executionHostId)
  const execOptions = ghOptions(args.repoPath, args.repository, connectionId, options)
  await acquire()
  try {
    const [parentStacks, currentStacks] = await Promise.all([
      getStacksForPullRequest(args.repository, args.parentReview.number, execOptions),
      getStacksForPullRequest(args.repository, args.currentReview.number, execOptions)
    ])
    const existingStackNumber = registeredStackNumber(
      args.parentReview,
      args.currentReview,
      parentStacks,
      currentStacks
    )
    if (existingStackNumber) {
      return {
        ok: true,
        ...args.currentReview,
        stackNumber: existingStackNumber,
        parentReview: args.parentReview
      }
    }
    if (currentStacks.length > 0) {
      return {
        ...stackedReviewFailure('stack_conflict'),
        createdReview: args.currentReview
      }
    }
    const parentError = validateParentStack(args.parentReview, parentStacks)
    if (parentError) {
      return { ...parentError, createdReview: args.currentReview }
    }

    const parentStack = parentStacks[0]
    const endpoint = parentStack
      ? `repos/${args.repository.owner}/${args.repository.repo}/stacks/${parentStack.number}/add`
      : `repos/${args.repository.owner}/${args.repository.repo}/stacks`
    const pullRequests = parentStack
      ? [args.currentReview.number]
      : [args.parentReview.number, args.currentReview.number]
    const command = ['api', '-X', 'POST', endpoint]
    for (const pullRequest of pullRequests) {
      command.push('-F', `pull_requests[]=${pullRequest}`)
    }
    const { stdout } = await ghExecFileAsync(command, {
      ...execOptions,
      idempotent: false
    })
    const stackNumber = Number((JSON.parse(stdout) as { number?: unknown }).number)
    if (!Number.isInteger(stackNumber) || stackNumber <= 0) {
      throw new Error('GitHub returned an invalid stack response.')
    }
    return {
      ok: true,
      ...args.currentReview,
      stackNumber,
      parentReview: args.parentReview
    }
  } catch (error) {
    console.warn('GitHub stack registration failed:', error)
    return {
      ...(isStacksUnavailableError(error)
        ? stackedReviewFailure('stack_registration_unavailable')
        : stackedReviewFailure('stack_registration_failed', {}, 'unknown')),
      createdReview: args.currentReview
    }
  } finally {
    release()
  }
}
