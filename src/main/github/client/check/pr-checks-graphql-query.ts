export const PR_CHECKS_ROLLUP_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    databaseId
                    name
                    status
                    conclusion
                    detailsUrl
                    url
                    startedAt
                    completedAt
                    checkSuite {
                      databaseId
                      workflowRun {
                        databaseId
                      }
                    }
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
                    createdAt
                  }
                }
              }
            }
            checkSuites(first: 100) {
              nodes {
                databaseId
                status
                conclusion
                url
                app {
                  name
                  slug
                }
              }
            }
          }
        }
      }
    }
  }
}
`

export type GraphQLPRChecksResponse = {
  errors?: unknown[]

  data?: {
    repository?: {
      pullRequest?: {
        headRefOid?: string | null
        commits?: {
          nodes?: { commit?: GraphQLPRChecksCommit | null }[] | null
        } | null
      } | null
    } | null
  } | null
}

export type GraphQLPRChecksCommit = {
  oid?: string | null

  statusCheckRollup?: {
    contexts?: {
      nodes?: GraphQLStatusCheckContext[] | null
    } | null
  } | null
  checkSuites?: {
    nodes?: GraphQLCheckSuite[] | null
  } | null
}

export type GraphQLCheckRunContext = {
  __typename: 'CheckRun'
  databaseId?: number | null
  name?: string | null
  status?: string | null
  conclusion?: string | null
  detailsUrl?: string | null
  url?: string | null
  startedAt?: string | null
  completedAt?: string | null
  checkSuite?: {
    databaseId?: number | null
    workflowRun?: { databaseId?: number | null } | null
  } | null
}

export type GraphQLStatusContext = {
  __typename: 'StatusContext'
  context?: string | null
  state?: string | null
  targetUrl?: string | null
  createdAt?: string | null
}

export type GraphQLStatusCheckContext =
  | GraphQLCheckRunContext
  | GraphQLStatusContext
  | { __typename?: string | null }

export type GraphQLCheckSuite = {
  databaseId?: number | null
  status?: string | null
  conclusion?: string | null
  url?: string | null
  app?: { name?: string | null; slug?: string | null } | null
}

export type RestCheckRun = {
  id?: number
  name: string
  status: string
  conclusion: string | null
  html_url: string
  details_url: string | null
  started_at?: string | null
  completed_at?: string | null
}

export type RestCommitStatus = {
  context?: string
  state?: string
  target_url?: string | null
  created_at?: string | null
}

export type RestCheckSuite = {
  id?: number | null
  status: string | null
  conclusion: string | null
  app?: { name?: string | null; slug?: string | null } | null
}
