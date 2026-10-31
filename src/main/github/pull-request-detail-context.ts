import { z } from 'zod'
import type {
  GitHubAssignableUser,
  GitHubPRFileViewedState
} from '../../shared/github/pull-request-types'
import { extractExecError } from '../git/exec-error'
import { ghExecFileAsync, ghRepoExecOptions, githubRepoContext } from './gh-utils'
import type { LocalGitExecOptions } from './gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from './github-api-repository'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from './rate-limit'
import { getWorkItemParticipants } from './work-item-participants'

function detailContextQuery(includeContext: boolean): string {
  const context = includeContext
    ? `pullRequest(number: $number) {
      participants(first: 100) {
        nodes { login avatarUrl(size: 48) ... on User { name } }
      }
    }`
    : ''
  return `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    ${context}
    viewedPullRequest: pullRequest(number: $number) {
      id
      files(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`
}

const envelopeSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequest: z.record(z.string(), z.unknown()).nullish(),
          viewedPullRequest: z.record(z.string(), z.unknown()).nullish()
        })
        .nullish()
    })
    .nullish(),
  errors: z
    .array(z.object({ path: z.array(z.union([z.string(), z.number()])).optional() }))
    .optional()
})
const participantsSchema = z.object({
  nodes: z.array(
    z.object({ login: z.string(), avatarUrl: z.string(), name: z.string().nullish() }).nullable()
  )
})
const filesSchema = z.object({
  id: z.string(),
  files: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
    nodes: z.array(
      z
        .object({
          path: z.string(),
          viewerViewedState: z.enum(['VIEWED', 'UNVIEWED', 'DISMISSED']).nullable()
        })
        .nullable()
    )
  })
})

export type PRFileViewedStatesResult = {
  pullRequestId: string
  viewedStates: Map<string, GitHubPRFileViewedState>
}
type PRDetailContext = {
  participants: GitHubAssignableUser[]
  viewedStates: PRFileViewedStatesResult | null
}

function sourceFailed(
  envelope: z.infer<typeof envelopeSchema>,
  source: string,
  alias = 'pullRequest'
): boolean {
  return Boolean(
    envelope.errors?.some(
      ({ path }) =>
        !path?.length ||
        path[0] !== 'repository' ||
        (path[1] !== 'pullRequest' && path[1] !== 'viewedPullRequest') ||
        (path[1] === alias && (path.length < 3 || path[2] === source))
    )
  )
}

async function readPRDetailContext(
  repoPath: string,
  prNumber: number,
  repository: GitHubApiRepository | null,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions
): Promise<Partial<PRDetailContext>> {
  if (!repository) {
    return {}
  }
  const ghOptions = {
    ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
    ...githubHostExecOptions(repository)
  }
  const result: Partial<PRDetailContext> = {}
  const viewedStates = new Map<string, GitHubPRFileViewedState>()
  let after: string | null = null
  try {
    for (let fetched = 0; fetched < 300; fetched += 100) {
      if (repositoryRateLimitGuard(repository, 'graphql', ghOptions).blocked) {
        break
      }
      const firstPage = fetched === 0
      const args = [
        'api',
        'graphql',
        '-f',
        `query=${detailContextQuery(firstPage)}`,
        '-f',
        `owner=${repository.owner}`,
        '-f',
        `repo=${repository.repo}`,
        '-F',
        `number=${prNumber}`
      ]
      if (after) {
        args.push('-f', `after=${after}`)
      }
      noteRepositoryRateLimitSpend(repository, 'graphql', 1, ghOptions)
      let stdout: string
      try {
        stdout = (await ghExecFileAsync(args, ghOptions)).stdout
      } catch (error) {
        const partial = extractExecError(error).stdout
        if (!partial) {
          throw error
        }
        stdout = partial
      }
      const envelope = envelopeSchema.parse(JSON.parse(stdout))
      const pr = envelope.data?.repository?.pullRequest
      if (firstPage) {
        const participants = participantsSchema.safeParse(pr?.participants)
        if (participants.success && !sourceFailed(envelope, 'participants')) {
          result.participants = participants.data.nodes.flatMap((user) =>
            user?.login ? [{ ...user, name: user.name ?? null }] : []
          )
        }
      }
      const files = filesSchema.safeParse(envelope.data?.repository?.viewedPullRequest)
      if (
        !files.success ||
        sourceFailed(envelope, 'files', 'viewedPullRequest') ||
        sourceFailed(envelope, 'id', 'viewedPullRequest')
      ) {
        break
      }
      for (const file of files.data.files.nodes) {
        if (file?.path && file.viewerViewedState) {
          viewedStates.set(file.path, file.viewerViewedState)
        }
      }
      const page = files.data.files.pageInfo
      if (!page.hasNextPage || fetched === 200) {
        result.viewedStates = { pullRequestId: files.data.id, viewedStates }
        break
      }
      if (!page.endCursor || page.endCursor === after) {
        break
      }
      after = page.endCursor
    }
  } catch {
    // A failed file page must not discard participants from the first page.
  }
  return result
}

export async function getPRDetailContext(
  repoPath: string,
  prNumber: number,
  repository: GitHubApiRepository | null,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRDetailContext> {
  const context = await readPRDetailContext(
    repoPath,
    prNumber,
    repository,
    connectionId,
    localGitOptions
  )
  const participants =
    context.participants ??
    (await getWorkItemParticipants(
      repoPath,
      { number: prNumber, type: 'pr' },
      repository,
      connectionId,
      localGitOptions
    ))
  return {
    participants,
    viewedStates: context.viewedStates ?? null
  }
}
