import { z } from 'zod'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { extractExecError } from '../../../git/command-runner/process-capture/exec-error'
import { githubHostExecOptions } from '../../repositories/github-repository-host'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../../shared/github/repositories/repository-identity'
import { noteRepositoryRateLimitSpend } from '../../api/rate-limit'
import type { GhExecOptions } from '../github-exec-scope'
import type { PullRequestLookupData } from './pull-request-lookup-data'
import {
  collectPRCheckRollup,
  createPRCheckRollupPageReader,
  prCheckRollupCommitsSchema,
  prCheckRollupFields
} from '../check/pr-check-rollup'

const CHECKS_FIELDS = prCheckRollupFields()

const SIDEBAR_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $checksCursor: String, $suitesCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number title state url updatedAt isDraft mergeable reviewDecision mergeStateStatus
      autoMergeRequest { enabledAt }
      latestOpinionatedReviews(first: 100) { nodes { author { login avatarUrl } state } }
      baseRefName headRefName baseRefOid headRefOid isCrossRepository
      headRepositoryOwner { login }
      headRepository { name }
      ${CHECKS_FIELDS}
      stack { number size baseRefName }
      stackEntry { position }
    }
  }
}`

const errorsSchema = z
  .array(
    z.object({
      type: z.string().optional(),
      path: z.array(z.union([z.string(), z.number()])).optional()
    })
  )
  .optional()

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  url: z.string(),
  updatedAt: z.string(),
  isDraft: z.boolean(),
  mergeable: z.enum(['UNKNOWN', 'MERGEABLE', 'CONFLICTING']),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  mergeStateStatus: z.string().nullable(),
  autoMergeRequest: z.object({ enabledAt: z.string() }).nullable(),
  latestOpinionatedReviews: z.object({ nodes: z.array(z.unknown()) }).nullish(),
  baseRefName: z.string(),
  headRefName: z.string(),
  baseRefOid: z.string().nullable(),
  headRefOid: z.string().nullable(),
  isCrossRepository: z.boolean().optional(),
  headRepositoryOwner: z.object({ login: z.string() }).nullable(),
  headRepository: z.object({ name: z.string() }).nullable(),
  commits: z.unknown(),
  stack: z.unknown().optional(),
  stackEntry: z.unknown().optional()
})
const stackSchema = z.object({
  number: z.number().int().positive(),
  size: z.number().int().positive(),
  baseRefName: z.string().trim().min(1)
})
const stackEntrySchema = z.object({ position: z.number().int().positive() })
const envelopeSchema = z.object({
  data: z.object({ repository: z.object({ pullRequest: pullRequestSchema }) }),
  errors: errorsSchema
})
const missingEnvelopeSchema = z.object({
  data: z.object({ repository: z.object({ pullRequest: z.null() }) }),
  errors: errorsSchema
})

async function readQuery(
  repository: GitHubApiRepository,
  number: number,
  options: GhExecOptions,
  query: string,
  cursor?: string
): Promise<{ payload: unknown; failure?: { error: unknown } }> {
  noteRepositoryRateLimitSpend(repository, 'graphql', 1, options)
  const args = [
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-f',
    `owner=${repository.owner}`,
    '-f',
    `repo=${repository.repo}`,
    '-F',
    `number=${number}`
  ]
  if (cursor) {
    args.push('-f', `checksCursor=${cursor}`)
  }
  let stdout: string
  let failure: { error: unknown } | undefined
  try {
    stdout = (await ghExecFileAsync(args, { ...options, ...githubHostExecOptions(repository) }))
      .stdout
  } catch (error) {
    failure = { error }
    stdout = extractExecError(error).stdout
  }
  try {
    return { payload: JSON.parse(stdout), failure }
  } catch {
    return { payload: undefined, failure }
  }
}

export async function readPullRequestSidebarQuery(
  repository: GitHubApiRepository,
  number: number,
  options: GhExecOptions,
  checkPageLimit?: number
): Promise<PullRequestLookupData | null | undefined> {
  if (repository.host?.toLowerCase() !== 'github.com') {
    return undefined
  }
  const response = await readQuery(repository, number, options, SIDEBAR_QUERY)
  const missing = missingEnvelopeSchema.safeParse(response.payload)
  if (
    missing.success &&
    missing.data.errors?.length &&
    missing.data.errors.every(
      ({ type, path }) =>
        type === 'NOT_FOUND' &&
        path?.length === 2 &&
        path[0] === 'repository' &&
        path[1] === 'pullRequest'
    )
  ) {
    return null
  }
  const parsed = envelopeSchema.safeParse(response.payload)
  if (!parsed.success) {
    if (response.failure) {
      throw response.failure.error
    }
    return undefined
  }
  const envelope = parsed.data
  const errors = envelope.errors ?? []
  const stackErrors = errors.filter(
    ({ path }) => path?.[2] === 'stack' || path?.[2] === 'stackEntry'
  )
  if (
    errors.some(
      ({ path }) =>
        path?.[0] !== 'repository' ||
        path[1] !== 'pullRequest' ||
        (path[2] !== 'stack' && path[2] !== 'stackEntry' && path[2] !== 'commits')
    )
  ) {
    if (response.failure) {
      throw response.failure.error
    }
    return undefined
  }
  const pr = envelope.data.repository.pullRequest
  if (pr.number !== number) {
    return undefined
  }
  let statusCheckRollup: unknown[] | undefined
  try {
    if (!pr.headRefOid || errors.some(({ path }) => path?.[2] === 'commits')) {
      throw new Error('Missing PR head')
    }
    statusCheckRollup = await collectPRCheckRollup(
      {
        number: pr.number,
        headRefOid: pr.headRefOid,
        commits: prCheckRollupCommitsSchema.parse(pr.commits)
      },
      createPRCheckRollupPageReader(repository, number, options),
      checkPageLimit
    )
  } catch {
    // Metadata remains usable when complete checks need REST recovery.
  }
  const stack = stackSchema.safeParse(pr.stack)
  const entry = stackEntrySchema.safeParse(pr.stackEntry)
  const validStack = stack.success && entry.success && entry.data.position <= stack.data.size
  const stackMetadataChecked =
    stackErrors.length === 0 && ((pr.stack === null && pr.stackEntry === null) || validStack)
  const { commits: _commits, stackEntry: _stackEntry, latestOpinionatedReviews, ...metadata } = pr
  return {
    ...metadata,
    latestReviews: latestOpinionatedReviews?.nodes,
    baseRefOid: pr.baseRefOid ?? undefined,
    headRefOid: pr.headRefOid ?? undefined,
    statusCheckRollup: statusCheckRollup ?? [],
    checksUnavailable: statusCheckRollup === undefined,
    stackMetadataChecked,
    stack:
      stackMetadataChecked && validStack
        ? {
            number: stack.data.number,
            size: stack.data.size,
            position: entry.data.position,
            baseRefName: stack.data.baseRefName
          }
        : undefined
  }
}
