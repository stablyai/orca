import type { HostedReviewInfo, HostedReviewLookupResult } from '../../shared/hosted-review'
import {
  getForgeProviderForRepository,
  HostedReviewLookupError,
  type ForgeProviderId
} from './forge-provider'
import type { HostedReviewExecutionOptions } from './hosted-review-git-options'

const NETWORK_ERROR_CODES = new Set([
  'ABORT_ERR',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET'
])

function classifyHostedReviewProviderError(
  error: unknown
): HostedReviewLookupError['errorType'] | null {
  const messages: string[] = []
  const codes = new Set<string>()
  const names = new Set<string>()
  const visited = new Set<object>()
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    if (typeof current === 'string') {
      messages.push(current)
      break
    }
    if ((typeof current !== 'object' && typeof current !== 'function') || visited.has(current)) {
      break
    }
    visited.add(current)
    const message = readErrorProperty(current, 'message')
    if (typeof message === 'string') {
      messages.push(message)
    }
    const code = readErrorProperty(current, 'code')
    if (typeof code === 'string') {
      codes.add(code.toUpperCase())
    }
    const name = readErrorProperty(current, 'name')
    if (typeof name === 'string') {
      names.add(name.toUpperCase())
    }
    current = readErrorProperty(current, 'cause')
  }
  const message = messages.join(' ')
  const lower = message.toLowerCase()
  if (lower.includes('rate limit') || lower.includes('http 429')) {
    return 'rate_limited'
  }
  if (/http 5\d\d/.test(lower)) {
    return 'server_error'
  }
  if (
    lower.includes('timeout') ||
    lower.includes('network') ||
    lower.includes('no such host') ||
    lower.includes('could not resolve host') ||
    lower.includes('connection reset') ||
    names.has('ABORTERROR') ||
    [...codes].some((code) => NETWORK_ERROR_CODES.has(code))
  ) {
    return 'network'
  }
  if (lower.includes('http 403') || lower.includes('forbidden')) {
    return 'permission'
  }
  if (lower.includes('http 404') || lower.includes('could not resolve to a repository')) {
    return 'repo_unavailable'
  }
  if (lower.includes('http 401') || /auth|login|credential/i.test(message)) {
    return 'auth'
  }
  if (/command not found|enoent|not installed/i.test(message)) {
    return 'cli_unavailable'
  }
  return null
}

function readErrorProperty(
  error: object,
  property: 'cause' | 'code' | 'message' | 'name'
): unknown {
  try {
    return Reflect.get(error, property)
  } catch {
    return undefined
  }
}

function reviewLinkForProvider(
  input: HostedReviewLookupInput,
  provider: ForgeProviderId
): { linkedReviewNumber?: number | null; fallbackReviewNumber?: number | null } {
  switch (provider) {
    case 'github':
      return {
        linkedReviewNumber: input.linkedGitHubPR ?? null,
        fallbackReviewNumber: input.linkedGitHubPR == null ? (input.fallbackGitHubPR ?? null) : null
      }
    case 'gitlab':
      return { linkedReviewNumber: input.linkedGitLabMR ?? null }
    case 'bitbucket':
      return { linkedReviewNumber: input.linkedBitbucketPR ?? null }
    case 'azure-devops':
      return { linkedReviewNumber: input.linkedAzureDevOpsPR ?? null }
    case 'gitea':
      return { linkedReviewNumber: input.linkedGiteaPR ?? null }
  }
}

type HostedReviewLookupInput = {
  repoPath: string
  connectionId?: string | null
  branch: string
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  currentHeadOid?: string | null
} & HostedReviewExecutionOptions

// Why: older internal callers still consume null-or-review and require the
// typed failure value to be projected back into their exception contract.
export async function getHostedReviewForBranch(
  input: HostedReviewLookupInput
): Promise<HostedReviewInfo | null> {
  const result = await lookupHostedReviewForBranch(input)
  switch (result.kind) {
    case 'found':
      return result.review
    case 'not-found':
      return null
    case 'upstream-error':
      throw new HostedReviewLookupError(
        result.provider,
        result.errorType,
        'Hosted review lookup failed.'
      )
  }
}

export async function lookupHostedReviewForBranch(
  input: HostedReviewLookupInput
): Promise<HostedReviewLookupResult> {
  const branchName = input.branch.replace(/^refs\/heads\//, '')
  // Why: detached HEAD cannot use branch lookup, but provider-specific exact
  // ids can still resolve the review without probing an empty branch name.
  if (
    !branchName &&
    input.linkedGitHubPR == null &&
    input.fallbackGitHubPR == null &&
    input.linkedGitLabMR == null &&
    input.linkedBitbucketPR == null &&
    input.linkedAzureDevOpsPR == null &&
    input.linkedGiteaPR == null
  ) {
    return { kind: 'not-found' }
  }

  let provider
  try {
    provider = await getForgeProviderForRepository({
      repoPath: input.repoPath,
      connectionId: input.connectionId,
      ...(input.localGitExecOptions ? { localGitExecOptions: input.localGitExecOptions } : {})
    })
  } catch (error) {
    return hostedReviewLookupFailure(error, 'unknown')
  }
  if (!provider) {
    return { kind: 'not-found' }
  }
  try {
    const review = await provider.getReviewForBranch({
      repoPath: input.repoPath,
      connectionId: input.connectionId,
      branch: branchName,
      ...(input.localGitExecOptions ? { localGitExecOptions: input.localGitExecOptions } : {}),
      githubCurrentHeadOid: input.currentHeadOid ?? null,
      ...reviewLinkForProvider(input, provider.id)
    })
    return review ? { kind: 'found', review } : { kind: 'not-found' }
  } catch (error) {
    return hostedReviewLookupFailure(error, provider.id)
  }
}

export function hostedReviewLookupFailure(
  error: unknown,
  provider: ForgeProviderId | 'unknown' = 'unknown'
): HostedReviewLookupResult {
  if (error instanceof HostedReviewLookupError) {
    return {
      kind: 'upstream-error',
      provider: error.provider,
      errorType: error.errorType
    }
  }
  const errorType = classifyHostedReviewProviderError(error)
  if (!errorType) {
    throw error
  }
  // Why: provider clients may throw secrets or command text; serialize only a
  // stable classification while the original failure remains local.
  return { kind: 'upstream-error', provider, errorType }
}
