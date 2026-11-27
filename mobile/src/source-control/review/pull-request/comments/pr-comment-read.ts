import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { PRComment } from '../../../../../../src/shared/github/comments/comment-types'
import type { GitHubWorkItemDetails } from '../../../../../../src/shared/github/work-items/work-item-types'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { isMobileMethodUnavailableError } from '../../../../transport/rpc/mobile-method-unavailable'
import { githubPrRequestParams } from '../../github-operations/github-pr-repo-slug'
import { githubPrCommentsRead } from '../../github-operations/github-pr-read-operations'
import { prRepoSlug, type PrDetailsInput } from '../mobile-pr-queries'

export class PrCommentsUnavailableError extends Error {}

/** A post-write read bypasses the host cache. */
export async function readPrComments(
  client: RpcClient,
  worktreeId: string,
  input: PrDetailsInput,
  noCache = true
): Promise<PRComment[]> {
  const raw = await githubPrCommentsRead.request(
    client,
    githubPrRequestParams(
      githubPrCommentsRead.operation.method,
      worktreeId,
      { prNumber: input.number, noCache },
      { prRepo: prRepoSlug(input) }
    )
  )
  if (!raw.ok && isMobileMethodUnavailableError(raw.error.code, raw.error.message)) {
    throw new PrCommentsUnavailableError(raw.error.message)
  }
  return githubPrCommentsRead.interpret(raw)
}

export function acceptPrComments(
  queryClient: QueryClient,
  detailsKey: QueryKey,
  comments: PRComment[] | null,
  updatedAt?: number
): void {
  const current = queryClient.getQueryData<GitHubWorkItemDetails>(detailsKey)
  if (!current) {
    return
  }
  // The host also returns [] when all comment sources fail; verify before clearing the conversation.
  if (comments === null || (comments.length === 0 && current.comments.length > 0)) {
    void queryClient.invalidateQueries({ queryKey: detailsKey, exact: true })
    return
  }
  queryClient.setQueryData<GitHubWorkItemDetails>(
    detailsKey,
    { ...current, comments },
    { updatedAt }
  )
}
