// Why: review thread resolution status + thread IDs are GraphQL-only (REST pulls/{n}/comments omits them).
export const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          line
          startLine
          originalLine
          originalStartLine
          comments(first: 100) {
            nodes {
              id
              databaseId
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
          }
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
