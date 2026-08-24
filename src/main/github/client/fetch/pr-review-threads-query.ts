// Why: review thread resolution status + thread IDs are GraphQL-only (REST pulls/{n}/comments omits them).
// Shared thread selection so the first-page and follow-up-page queries can't drift apart.
const REVIEW_THREAD_FIELDS = `
          id
          isResolved
          isOutdated
          path
          diffSide
          line
          startLine
          originalLine
          originalStartLine
          comments(first: 100) {
            nodes {
              id
              databaseId
              state
              diffHunk
              author { __typename login avatarUrl(size: 48) }
              body
              createdAt
              url
              path
              reactionGroups {
                content
                viewerHasReacted
                reactors {
                  totalCount
                }
              }
            }
          }`

// Why: 50/page (not 100) — each thread now carries diffHunk text, so a full page stays well under response-size limits.
export const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 50) {
        pageInfo { hasNextPage endCursor }
        nodes {
${REVIEW_THREAD_FIELDS}
        }
      }
      comments(first: 100) {
        nodes {
          id
          databaseId
          author { __typename login avatarUrl(size: 48) }
          body
          createdAt
          url
          reactionGroups {
            content
            viewerHasReacted
            reactors {
              totalCount
            }
          }
        }
      }
      reviews(first: 100) {
        nodes {
          id
          databaseId
          author { __typename login avatarUrl(size: 48) }
          body
          createdAt
          url
          reactionGroups {
            content
            viewerHasReacted
            reactors {
              totalCount
            }
          }
        }
      }
    }
  }
}`

// Why: follow-up pages only need the thread connection; refetching comments/reviews would waste point budget.
export const REVIEW_THREADS_PAGE_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!, $after: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
${REVIEW_THREAD_FIELDS}
        }
      }
    }
  }
}`
