// The review writes a message's review reply asks for, through the runtime's repo-scoped GitHub and
// GitLab methods: the ones the review RPCs call. Resolves are idempotent; a reply is not, so a run
// that may repeat one already posted (`reread`) first reads the reply threads, newest first, and the
// conversation since, and skips what this account already posted there.

import type { AgentSessionReviewReply } from '../../../shared/agent-session-review-reply'
import type {
  ReviewReplyPost,
  ReviewReplyPosts
} from '../../github/client/fetch/review-reply-posts'
import type { RuntimeReviewCommandSurface } from '../../runtime/runtime-review-command-surface'
import type { RuntimeGitHubReviewQueryCommands } from '../../runtime/runtime-github-review-query-commands'

export type StructuredAgentSessionReviewRuntime = Pick<
  RuntimeReviewCommandSurface,
  | 'resolveRepoReviewThread'
  | 'resolveGitLabRepoMRDiscussion'
  | 'addRepoPRReviewCommentReply'
  | 'addRepoIssueComment'
> &
  Pick<RuntimeGitHubReviewQueryCommands, 'getRepoReviewReplyPosts'> & {
    /** Tells this machine's views of the PR to refetch, as the desktop's own writes do. */
    reviewWritten: (repoSelector: string, prNumber: number) => Promise<void>
  }

/** How far before acceptance a post still counts as this message's: the host's clock and
 *  GitHub's can disagree by seconds. */
export const REVIEW_REPLY_CLOCK_MARGIN_MS = 60_000

/** The checks panel's ceiling: the shared GitHub client keeps four calls in flight. */
const REVIEW_REPLY_CONCURRENCY = 4

type ReviewWrite = () => Promise<string | null>

/** Runs every write; answers the first failure's words, or null when all went through. */
export async function runStructuredAgentSessionReviewReply(
  runtime: StructuredAgentSessionReviewRuntime,
  spec: AgentSessionReviewReply,
  options: {
    /** When the agent took the message: a reply posted since is this message's. */
    acceptedAt: number
    /** A run that may follow an earlier one cut off before its receipt. */
    reread: boolean
    log: (message: string, error?: unknown) => void
  }
): Promise<string | null> {
  const repo = `id:${spec.repoId}`
  const writes: ReviewWrite[] =
    spec.provider === 'gitlab'
      ? spec.resolve.map((discussionId) => async () => {
          const resolved = await runtime.resolveGitLabRepoMRDiscussion(
            repo,
            spec.iid,
            discussionId,
            true
          )
          return resolved.ok ? null : resolved.error
        })
      : await gitHubWrites(runtime, repo, spec, options)
  const failures = await runBounded(writes, options.log)
  // GitLab views already poll; a GitHub PR view refetches only when told.
  if (spec.provider === 'github' && failures.length < writes.length) {
    await runtime
      .reviewWritten(repo, spec.prNumber)
      .catch((error: unknown) => options.log('review reply: the PR view was not told', error))
  }
  return failures[0] ?? null
}

async function gitHubWrites(
  runtime: StructuredAgentSessionReviewRuntime,
  repo: string,
  spec: Extract<AgentSessionReviewReply, { provider: 'github' }>,
  options: {
    acceptedAt: number
    reread: boolean
    log: (message: string, error?: unknown) => void
  }
): Promise<ReviewWrite[]> {
  const posted = options.reread ? await postedSince(runtime, repo, spec, options) : null
  // A reply with no thread to read, or with no read at all, is posted: at worst once more. Only a
  // failed read is logged; a reply with no thread id is rare (path-only review comments).
  const alreadyPosted = (body: string, at: { threadId?: string } | null): boolean => {
    if (!posted) {
      return false
    }
    const comments = at === null ? posted.conversation : at.threadId && posted.threads[at.threadId]
    return (comments || []).some((comment) => comment.body.trim() === body.trim())
  }
  const prRepo = spec.prRepo ?? null
  const conversationReply = spec.conversationReply
  return [
    ...spec.resolve.map(
      (threadId) => async () =>
        (await runtime.resolveRepoReviewThread(repo, threadId, true, prRepo))
          ? null
          : 'Could not resolve the review thread.'
    ),
    ...spec.replies
      .filter((reply) => !alreadyPosted(spec.replyBody, reply))
      .map((reply) => async () => {
        const result = await runtime.addRepoPRReviewCommentReply(repo, {
          prNumber: spec.prNumber,
          commentId: reply.commentId,
          body: spec.replyBody,
          ...(reply.threadId ? { threadId: reply.threadId } : {}),
          ...(reply.path ? { path: reply.path } : {}),
          ...(reply.line !== undefined ? { line: reply.line } : {}),
          prRepo
        })
        return result.ok ? null : result.error
      }),
    ...(conversationReply && !alreadyPosted(conversationReply, null)
      ? [
          async () => {
            const result = await runtime.addRepoIssueComment(
              repo,
              spec.prNumber,
              conversationReply,
              prRepo
            )
            return result.ok ? null : result.error
          }
        ]
      : [])
  ]
}

/** What this account posted since shortly before the agent took the message, read from GitHub. A
 *  failed read answers null; an unknown account matches any author. Both are reported. */
async function postedSince(
  runtime: StructuredAgentSessionReviewRuntime,
  repo: string,
  spec: Extract<AgentSessionReviewReply, { provider: 'github' }>,
  options: { acceptedAt: number; log: (message: string, error?: unknown) => void }
): Promise<ReviewReplyPosts | null> {
  if (spec.replies.length === 0 && !spec.conversationReply) {
    return null
  }
  const since = options.acceptedAt - REVIEW_REPLY_CLOCK_MARGIN_MS
  let read: ReviewReplyPosts
  try {
    read = await runtime.getRepoReviewReplyPosts(repo, {
      prNumber: spec.prNumber,
      prRepo: spec.prRepo ?? null,
      threadIds: spec.replies.flatMap((reply) => (reply.threadId ? [reply.threadId] : [])),
      since: new Date(since).toISOString()
    })
  } catch (error) {
    options.log('review reply: could not read the PR before replying; a reply may repeat', error)
    return null
  }
  const login = read.viewerLogin
  if (login === null) {
    options.log('review reply: the account is unknown, so a reply is matched by its text', null)
  }
  const mine = (comments: readonly ReviewReplyPost[]) =>
    comments.filter(
      (comment) =>
        Date.parse(comment.createdAt) >= since && (login === null || comment.author === login)
    )
  return {
    viewerLogin: login,
    threads: Object.fromEntries(
      Object.entries(read.threads).map(([threadId, comments]) => [threadId, mine(comments)])
    ),
    conversation: mine(read.conversation)
  }
}

async function runBounded(
  writes: readonly ReviewWrite[],
  log: (message: string, error?: unknown) => void
): Promise<string[]> {
  const failures: string[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < writes.length) {
      const write = writes[next++]!
      try {
        const failure = await write()
        if (failure !== null) {
          failures.push(failure)
        }
      } catch (error) {
        log('review reply: a review write failed', error)
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(REVIEW_REPLY_CONCURRENCY, writes.length) }, worker)
  )
  return failures
}
