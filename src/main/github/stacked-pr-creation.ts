import type {
  CreateStackedHostedReviewInput,
  CreateStackedHostedReviewResult
} from '../../shared/hosted-review'
import { isDefaultGitHubHost } from '../../shared/github-repository-identity-key'
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

type StackedPullRequestPlan =
  | {
      ok: true
      repository: GitHubApiRepository
      parentReview: GitHubStackPullRequest
      currentReview: GitHubStackPullRequest | null
    }
  | Extract<CreateStackedHostedReviewResult, { ok: false }>

function creationError(error: string): Extract<CreateStackedHostedReviewResult, { ok: false }> {
  return { ok: false, code: 'validation', error }
}

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
  repoPath: string,
  repository: GitHubApiRepository,
  branch: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {},
  base?: string
): Promise<GitHubStackPullRequest[]> {
  const head = encodeURIComponent(`${repository.owner}:${branch}`)
  const baseQuery = base ? `&base=${encodeURIComponent(base)}` : ''
  const endpoint = `repos/${repository.owner}/${repository.repo}/pulls?head=${head}${baseQuery}&state=open&per_page=2`
  const { stdout } = await ghExecFileAsync(
    ['api', endpoint],
    ghOptions(repoPath, repository, connectionId, options)
  )
  return parseGitHubStackPullRequests(stdout)
}

async function getStacksForPullRequest(
  repoPath: string,
  repository: GitHubApiRepository,
  pullRequestNumber: number,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<GitHubStack[]> {
  const endpoint = `repos/${repository.owner}/${repository.repo}/stacks?pull_request=${pullRequestNumber}`
  const { stdout } = await ghExecFileAsync(
    ['api', endpoint],
    ghOptions(repoPath, repository, connectionId, options)
  )
  return parseGitHubStacks(stdout)
}

function validateParentStack(
  parentReview: NumberedHostedReviewSummary,
  stacks: GitHubStack[]
): Extract<CreateStackedHostedReviewResult, { ok: false }> | null {
  if (stacks.length > 1) {
    return creationError('The selected parent pull request belongs to multiple stacks.')
  }
  const stack = stacks[0]
  if (!stack) {
    return null
  }
  if (!stack.open) {
    return creationError('The selected parent belongs to a closed stack.')
  }
  if (stack.pull_requests.at(-1)?.number !== parentReview.number) {
    return creationError(
      'Choose the top pull request in the stack as the base branch before adding another layer.'
    )
  }
  return null
}

export async function prepareGitHubStackedPullRequest(
  repoPath: string,
  input: CreateStackedHostedReviewInput,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<StackedPullRequestPlan> {
  if (input.provider !== 'github') {
    return creationError('Stacked pull request creation is available only for GitHub repositories.')
  }
  const repository = await getOriginGitHubApiRepository(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
  if (!repository || !isDefaultGitHubHost(repository.host)) {
    return creationError('GitHub stacked pull requests are available only on GitHub.com.')
  }
  const base = normalizeHostedReviewBaseRef(input.base).trim()
  const head = input.head ? normalizeHostedReviewHeadRef(input.head).trim() : ''
  if (!base || !head || base.toLowerCase() === head.toLowerCase()) {
    return creationError('Choose a different parent branch before creating a stacked pull request.')
  }

  await acquire()
  try {
    const [parentPullRequests, currentPullRequests] = await Promise.all([
      findOpenPullRequestsForBranch(repoPath, repository, base, connectionId, options),
      findOpenPullRequestsForBranch(repoPath, repository, head, connectionId, options, base)
    ])
    if (parentPullRequests.length === 0) {
      return creationError(
        `The parent branch ${base} does not have an open pull request. Create that pull request first.`
      )
    }
    if (parentPullRequests.length !== 1) {
      return creationError(`Orca found multiple open pull requests for the parent branch ${base}.`)
    }
    if (currentPullRequests.length > 1) {
      return creationError(`Orca found multiple open pull requests for the current branch ${head}.`)
    }
    const parentReview = parentPullRequests[0]
    const currentReview = currentPullRequests[0] ?? null
    const [parentStacks, currentStacks] = await Promise.all([
      getStacksForPullRequest(repoPath, repository, parentReview.number, connectionId, options),
      currentReview
        ? getStacksForPullRequest(repoPath, repository, currentReview.number, connectionId, options)
        : Promise.resolve([])
    ])
    if (
      currentReview &&
      registeredStackNumber(parentReview, currentReview, parentStacks, currentStacks)
    ) {
      return { ok: true, repository, parentReview, currentReview }
    }
    if (currentStacks.length > 0) {
      return creationError('The pull request already belongs to a different GitHub stack.')
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
    return {
      ok: false,
      code: isStacksUnavailableError(error) ? 'validation' : 'unknown',
      error: isStacksUnavailableError(error)
        ? 'GitHub stacked pull requests are not available for this repository.'
        : 'Orca could not verify the parent pull request. Retry in a moment.'
    }
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
  // Why: a miss is -1, and -1 + 1 reads the first entry — which reports "already
  // registered" whenever the current PR heads a stack the parent has left.
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
  connectionId?: string | null
  options?: HostedReviewExecutionOptions
}): Promise<CreateStackedHostedReviewResult> {
  const options = args.options ?? {}
  await acquire()
  try {
    const [parentStacks, currentStacks] = await Promise.all([
      getStacksForPullRequest(
        args.repoPath,
        args.repository,
        args.parentReview.number,
        args.connectionId,
        options
      ),
      getStacksForPullRequest(
        args.repoPath,
        args.repository,
        args.currentReview.number,
        args.connectionId,
        options
      )
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
        ...creationError('The pull request already belongs to a different GitHub stack.'),
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
      ...ghOptions(args.repoPath, args.repository, args.connectionId, options),
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
      ok: false,
      code: isStacksUnavailableError(error) ? 'validation' : 'unknown',
      error: isStacksUnavailableError(error)
        ? 'The pull request was created, but GitHub stacks are not available for this repository.'
        : 'The pull request was created, but GitHub could not add it to the stack. Retry to finish stack registration.',
      createdReview: args.currentReview
    }
  } finally {
    release()
  }
}
