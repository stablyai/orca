import { z } from 'zod'
import { ghExecFileAsync } from '../../gh-utils'
import { extractExecError } from '../../../git/exec-error'
import { githubHostExecOptions, type GitHubApiRepository } from '../../github-api-repository'
import { noteRepositoryRateLimitSpend } from '../../rate-limit'
import type { GhExecOptions } from '../github-exec-scope'
import type { PullRequestLookupData } from './pull-request-lookup-data'

const CHECKS_FIELDS = `commits(last: 1) {
  nodes {
    commit {
      oid
      statusCheckRollup {
        contexts(first: 100, after: $checksCursor) {
          nodes {
            __typename
            ... on CheckRun { status conclusion }
            ... on StatusContext { state }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
}`

const SIDEBAR_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $checksCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number title state url updatedAt isDraft mergeable reviewDecision mergeStateStatus
      autoMergeRequest { enabledAt }
      baseRefName headRefName baseRefOid headRefOid isCrossRepository
      headRepositoryOwner { login }
      headRepository { name }
      ${CHECKS_FIELDS}
      stack { number size baseRefName }
      stackEntry { position }
    }
  }
}`

const CHECKS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $checksCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) { number ${CHECKS_FIELDS} }
  }
}`

const commitsSchema = z.object({
  nodes: z
    .array(
      z.object({
        commit: z.object({
          oid: z.string(),
          statusCheckRollup: z
            .object({
              contexts: z.object({
                nodes: z.array(z.record(z.string(), z.unknown()).nullable()),
                pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
              })
            })
            .nullable()
        })
      })
    )
    .max(1)
})
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
  baseRefName: z.string(),
  headRefName: z.string(),
  baseRefOid: z.string().nullable(),
  headRefOid: z.string().nullable(),
  isCrossRepository: z.boolean().optional(),
  headRepositoryOwner: z.object({ login: z.string() }).nullable(),
  headRepository: z.object({ name: z.string() }).nullable(),
  commits: commitsSchema,
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
const checksEnvelopeSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({ number: z.number(), commits: commitsSchema })
    })
  }),
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
  options: GhExecOptions
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
  const stackErrors = envelope.errors ?? []
  if (
    stackErrors.some(
      ({ path }) =>
        path?.[0] !== 'repository' ||
        path[1] !== 'pullRequest' ||
        (path[2] !== 'stack' && path[2] !== 'stackEntry')
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
  let contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts
  const statusCheckRollup = contexts?.nodes.flatMap((node) => (node ? [node] : [])) ?? []
  const cursors = new Set<string>()
  while (contexts?.pageInfo.hasNextPage) {
    const cursor = contexts.pageInfo.endCursor
    if (!cursor || cursors.has(cursor)) {
      return undefined
    }
    cursors.add(cursor)
    const page = await readQuery(repository, number, options, CHECKS_QUERY, cursor)
    if (page.failure) {
      throw page.failure.error
    }
    const parsedPage = checksEnvelopeSchema.safeParse(page.payload)
    if (!parsedPage.success) {
      return undefined
    }
    const next = parsedPage.data
    if (
      next.errors?.length ||
      next.data.repository.pullRequest.number !== number ||
      next.data.repository.pullRequest.commits.nodes[0]?.commit.oid !==
        pr.commits.nodes[0]?.commit.oid
    ) {
      return undefined
    }
    contexts = next.data.repository.pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.contexts
    if (!contexts) {
      return undefined
    }
    statusCheckRollup.push(...contexts.nodes.flatMap((node) => (node ? [node] : [])))
  }
  const stack = stackSchema.safeParse(pr.stack)
  const entry = stackEntrySchema.safeParse(pr.stackEntry)
  const validStack = stack.success && entry.success && entry.data.position <= stack.data.size
  const stackMetadataChecked =
    stackErrors.length === 0 && ((pr.stack === null && pr.stackEntry === null) || validStack)
  const { commits: _commits, stackEntry: _stackEntry, ...metadata } = pr
  return {
    ...metadata,
    baseRefOid: pr.baseRefOid ?? undefined,
    headRefOid: pr.headRefOid ?? undefined,
    statusCheckRollup,
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
