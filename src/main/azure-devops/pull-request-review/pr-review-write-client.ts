import { requestAzureDevOpsJsonAtBase } from '../azure-devops-api-request'
import { reserveAzureDevOpsWrite } from '../azure-devops-write-budget'
import {
  getAzureDevOpsCurrentUserId,
  pullRequestPath,
  type PullRequestLocation
} from './pr-review-read-client'

const WRITE_TIMEOUT_MS = 15_000
// A pinned version disables the version-negotiation retry, so a write is never sent twice.
const WRITE_SEARCH_PARAMS = { 'api-version': '6.0' }

/** Approve, approve with suggestions, reset, wait for author. Reject (-10) is never offered. */
export const AZURE_DEVOPS_ALLOWED_VOTES = [10, 5, 0, -5] as const
export type AzureDevOpsAllowedVote = (typeof AZURE_DEVOPS_ALLOWED_VOTES)[number]

export type AzureDevOpsPrCommentInput = {
  body: string
  /** Reply in this thread instead of opening a new one. */
  threadId?: number
  /** Anchor a new thread to a file, optionally at a line of the PR's version of it. */
  filePath?: string
  line?: number
}

export async function addAzureDevOpsPullRequestComment(
  location: PullRequestLocation,
  id: number,
  input: AzureDevOpsPrCommentInput
): Promise<{ threadId: number; commentId: number }> {
  await reserveAzureDevOpsWrite('comment')
  const threads = `${pullRequestPath(location, id)}/threads`
  if (input.threadId !== undefined) {
    const reply = await requestAzureDevOpsJsonAtBase<{ id?: number }>(
      location.collection,
      `${threads}/${encodeURIComponent(String(input.threadId))}/comments`,
      {
        method: 'POST',
        body: { content: input.body, parentCommentId: 1, commentType: 1 },
        searchParams: WRITE_SEARCH_PARAMS,
        timeoutMs: WRITE_TIMEOUT_MS
      },
      true
    )
    return { threadId: input.threadId, commentId: reply?.id ?? 0 }
  }
  const position = input.line ? { line: input.line, offset: 1 } : undefined
  const thread = await requestAzureDevOpsJsonAtBase<{ id?: number; comments?: { id?: number }[] }>(
    location.collection,
    threads,
    {
      method: 'POST',
      body: {
        status: 1,
        comments: [{ parentCommentId: 0, content: input.body, commentType: 1 }],
        ...(input.filePath
          ? {
              threadContext: {
                filePath: input.filePath.startsWith('/') ? input.filePath : `/${input.filePath}`,
                ...(position ? { rightFileStart: position, rightFileEnd: position } : {})
              }
            }
          : {})
      },
      searchParams: WRITE_SEARCH_PARAMS,
      timeoutMs: WRITE_TIMEOUT_MS
    },
    true
  )
  return { threadId: thread?.id ?? 0, commentId: thread?.comments?.[0]?.id ?? 0 }
}

export async function setAzureDevOpsPullRequestVote(
  location: PullRequestLocation,
  id: number,
  vote: AzureDevOpsAllowedVote
): Promise<{ vote: number }> {
  if (!AZURE_DEVOPS_ALLOWED_VOTES.includes(vote)) {
    throw new Error('Orca never rejects a pull request; use 10, 5, 0 or -5.')
  }
  const me = await getAzureDevOpsCurrentUserId(location.collection)
  if (!me) {
    throw new Error('Azure DevOps did not say who is signed in; run az login or check the token.')
  }
  await reserveAzureDevOpsWrite('vote')
  const result = await requestAzureDevOpsJsonAtBase<{ vote?: number }>(
    location.collection,
    `${pullRequestPath(location, id)}/reviewers/${encodeURIComponent(me)}`,
    {
      method: 'PUT',
      body: { vote },
      searchParams: WRITE_SEARCH_PARAMS,
      timeoutMs: WRITE_TIMEOUT_MS
    },
    true
  )
  return { vote: result?.vote ?? vote }
}
