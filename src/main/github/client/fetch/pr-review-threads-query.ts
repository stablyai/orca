const PAGE_INFO = 'pageInfo { hasNextPage endCursor }'
const COMMENT_FIELDS = `
  id databaseId author { __typename login avatarUrl(size: 48) }
  body bodyHTML createdAt url viewerDidAuthor
  reactionGroups { content viewerHasReacted reactors { totalCount } }
`
const THREAD_FIELDS = `
  id isResolved line startLine originalLine originalStartLine diffSide
  rootHunk: comments(first: 1) { nodes { diffHunk } }
  comments(first: 100) { ${PAGE_INFO} nodes { ${COMMENT_FIELDS} path } }
`
export type PRConversationSource = 'comments' | 'reviews' | 'reviewThreads'

export function reviewConversationQuery(source?: PRConversationSource): string {
  const connection = (name: PRConversationSource): string => {
    if (source && name !== source) {
      return ''
    }
    const fields =
      name === 'reviewThreads'
        ? THREAD_FIELDS
        : `${COMMENT_FIELDS}${name === 'reviews' ? ' submittedAt' : ''}`
    return `${name}(first: 100${source ? ', after: $cursor' : ''}) { ${PAGE_INFO} nodes { ${fields} } }`
  }
  return `query($owner: String!, $repo: String!, $pr: Int!${source ? ', $cursor: String!' : ''}) {
    repository(owner: $owner, name: $repo) { pullRequest(number: $pr) {
      ${connection('reviewThreads')} ${connection('comments')} ${connection('reviews')}
    } }
  }`
}

export const REVIEW_THREADS_QUERY = reviewConversationQuery()
export const REVIEW_THREAD_REPLIES_QUERY = `
query($threadId: ID!, $cursor: String!) {
  node(id: $threadId) { ... on PullRequestReviewThread {
    id isResolved line startLine originalLine originalStartLine diffSide
    comments(first: 100, after: $cursor) { ${PAGE_INFO} nodes { ${COMMENT_FIELDS} path } }
  } }
}`
