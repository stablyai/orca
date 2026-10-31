import { z } from 'zod'
import type { GitHubAssignableUser } from '../../shared/github/pull-request-types'

export const ISSUE_DETAILS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $includeItem: Boolean!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number @include(if: $includeItem) title @include(if: $includeItem)
      state @include(if: $includeItem)
      url @include(if: $includeItem)
      updatedAt @include(if: $includeItem)
      author @include(if: $includeItem) { __typename login avatarUrl(size: 48) }
      labels(first: 100) @include(if: $includeItem) {
        nodes { name }
        pageInfo { hasNextPage }
      }
      body
      assignees(first: 50) {
        nodes { login avatarUrl(size: 48) ... on User { name } }
        pageInfo { hasNextPage }
      }
      participants(first: 100) {
        nodes { login avatarUrl(size: 48) ... on User { name } }
      }
      comments(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          databaseId
          body
          createdAt
          url
          author {
            login
            avatarUrl(size: 48)
            ... on Bot { __typename }
          }
        }
      }
    }
  }
}`

export const issueItemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  url: z.string(),
  updatedAt: z.string(),
  author: z.object({ __typename: z.string(), login: z.string(), avatarUrl: z.string() }).nullable(),
  assignees: z.object({
    nodes: z.array(z.object({ login: z.string().min(1) })),
    pageInfo: z.object({ hasNextPage: z.literal(false) })
  }),
  labels: z.object({
    nodes: z.array(z.object({ name: z.string() })),
    pageInfo: z.object({ hasNextPage: z.literal(false) })
  })
})

export type GraphQLIssueDetailsResponse = {
  data?: {
    repository?: {
      issue?: {
        body?: string | null
        assignees?: { nodes?: (Partial<GitHubAssignableUser> | null)[] | null }
        participants?: { nodes?: GitHubAssignableUser[] }
        comments?: {
          pageInfo?: { hasNextPage: boolean }
          nodes?: {
            databaseId?: number | null
            body?: string | null
            createdAt?: string | null
            url?: string | null
            author?: {
              login?: string | null
              avatarUrl?: string | null
              __typename?: string
            } | null
          }[]
        }
      } | null
    } | null
  }
  errors?: { message?: string }[]
}
