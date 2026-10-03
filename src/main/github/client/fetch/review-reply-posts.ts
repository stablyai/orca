// What a review reply may already have posted on a PR: the newest comments on each reply's thread,
// the conversation comments since a moment, and who the repo's gh account is. Unlike the panel's
// comment read it throws on any failure, so a caller can tell "nothing posted" from "not read".

import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'

export type ReviewReplyPost = { author: string; body: string; createdAt: string }

export type ReviewReplyPosts = {
  /** The account this repo's gh calls run as; null when GitHub did not say. */
  viewerLogin: string | null
  /** The newest 100 comments on each asked thread, by thread id. */
  threads: Record<string, ReviewReplyPost[]>
  /** PR conversation comments updated since `since`, up to 100. */
  conversation: ReviewReplyPost[]
}

// GitHub node ids are base64url-like; anything else is not one, and is never put into the query.
const NODE_ID = /^[A-Za-z0-9_=+/-]{1,512}$/

function threadsQuery(threadIds: readonly string[]): string {
  const threads = threadIds.map(
    (id, index) =>
      `t${index}: node(id: ${JSON.stringify(id)}) { ... on PullRequestReviewThread { comments(last: 100) { nodes { author { login } body createdAt } } } }`
  )
  return `query { viewer { login } ${threads.join(' ')} }`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One comment as either API returns it; null for anything that is not one. */
function readPost(
  value: unknown,
  authorKey: 'author' | 'user',
  createdKey: string
): ReviewReplyPost | null {
  if (!isRecord(value) || typeof value[createdKey] !== 'string') {
    return null
  }
  const author = value[authorKey]
  return {
    author: isRecord(author) && typeof author.login === 'string' ? author.login : 'ghost',
    body: typeof value.body === 'string' ? value.body : '',
    createdAt: String(value[createdKey])
  }
}

function readPosts(values: unknown, authorKey: 'author' | 'user', createdKey: string) {
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    const read = readPost(value, authorKey, createdKey)
    return read ? [read] : []
  })
}

export async function getReviewReplyPosts(
  repoPath: string,
  args: {
    prNumber: number
    prRepo?: GitHubApiRepository | null
    threadIds: readonly string[]
    /** ISO time; the conversation read starts here. */
    since: string
  },
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ReviewReplyPosts> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    args.prRepo,
    connectionId,
    localGitOptions
  )
  if (!ownerRepo) {
    throw new Error('Not a GitHub repository.')
  }
  const threadIds = args.threadIds.filter((id) => NODE_ID.test(id))
  await acquire()
  try {
    const [graphql, rest] = await Promise.all([
      ghExecFileAsync(['api', 'graphql', '-f', `query=${threadsQuery(threadIds)}`], ghOptions),
      ghExecFileAsync(
        [
          'api',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${args.prNumber}/comments?since=${encodeURIComponent(args.since)}&per_page=100`
        ],
        ghOptions
      )
    ])
    const parsed: unknown = JSON.parse(graphql.stdout)
    const data = isRecord(parsed) ? parsed.data : undefined
    const errors = isRecord(parsed) && Array.isArray(parsed.errors) ? parsed.errors : []
    if (!isRecord(data) || errors.length > 0) {
      throw new Error(`GitHub refused the thread read: ${JSON.stringify(errors)}`)
    }
    const threads: Record<string, ReviewReplyPost[]> = {}
    threadIds.forEach((id, index) => {
      const node = data[`t${index}`]
      const comments = isRecord(node) && isRecord(node.comments) ? node.comments.nodes : []
      threads[id] = readPosts(comments, 'author', 'createdAt')
    })
    const conversation: unknown = JSON.parse(rest.stdout)
    if (!Array.isArray(conversation)) {
      throw new Error('GitHub answered the conversation read with something else.')
    }
    const viewer = data.viewer
    return {
      viewerLogin: isRecord(viewer) && typeof viewer.login === 'string' ? viewer.login : null,
      threads,
      conversation: readPosts(conversation, 'user', 'created_at')
    }
  } finally {
    release()
  }
}
