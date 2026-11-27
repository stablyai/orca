import type { GitHubRepositoryIdentity } from '../../../../shared/github/repositories/repository-identity'
import { githubRepoIdentityKey } from '../../../../shared/github/repositories/repository-identity-key'
import { codeHostReadExecutionScope } from '../../../source-control/code-host-read-execution-scope'
import type { GhExecOptions } from '../github-exec-scope'
import {
  parsePullRequestSidebarResponse,
  readPullRequestSidebarFirstPages,
  readPullRequestSidebarQuery,
  type PullRequestSidebarResponse
} from './pull-request-sidebar-query'

const BATCH_SIZE = 3
const BATCH_WINDOW_MS = 15

type PendingFirstPage = ReturnType<
  typeof Promise.withResolvers<PullRequestSidebarResponse | undefined>
> & {
  number: number
}
type SidebarBatch = {
  pending: PendingFirstPage[]
  timer: ReturnType<typeof setTimeout>
}
const batches = new Map<string, SidebarBatch>()

function requestFirstPage(
  repository: GitHubRepositoryIdentity,
  number: number,
  options: GhExecOptions,
  executionScope: string
): Promise<PullRequestSidebarResponse | undefined> {
  const key = JSON.stringify([
    executionScope,
    githubRepoIdentityKey(repository),
    codeHostReadExecutionScope(options),
    options.admissionTier
  ])
  const request = { number, ...Promise.withResolvers<PullRequestSidebarResponse | undefined>() }
  const flush = (batch: SidebarBatch): void => {
    batches.delete(key)
    clearTimeout(batch.timer)
    const { pending } = batch
    if (pending.length === 1) {
      pending[0]?.resolve(undefined)
      return
    }
    void readPullRequestSidebarFirstPages(
      repository,
      pending.map((entry) => entry.number),
      options
    ).then(
      (pages) => pending.forEach((entry, index) => entry.resolve(pages[index])),
      (error: unknown) => pending.forEach((entry) => entry.reject(error))
    )
  }
  const batch = batches.get(key)
  if (batch) {
    batch.pending.push(request)
    if (batch.pending.length === BATCH_SIZE) {
      flush(batch)
    }
  } else {
    const next: SidebarBatch = {
      pending: [request],
      timer: setTimeout(() => flush(next), BATCH_WINDOW_MS)
    }
    batches.set(key, next)
  }
  return request.promise
}

export async function readBatchedPullRequestSidebarQuery(
  repository: GitHubRepositoryIdentity,
  number: number,
  options: GhExecOptions,
  executionScope: string,
  checkPageLimit?: number
) {
  if (repository.host?.toLowerCase() === 'github.com' && !options.signal) {
    const response = await requestFirstPage(repository, number, options, executionScope)
    if (response) {
      const review = await parsePullRequestSidebarResponse(
        repository,
        number,
        options,
        response,
        checkPageLimit
      )
      if (review !== undefined) {
        return review
      }
    }
  }
  return readPullRequestSidebarQuery(repository, number, options, checkPageLimit)
}
