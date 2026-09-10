import type {
  GitHubProjectPartialFailure,
  GitHubProjectRef,
  GitHubProjectSummary
} from './github-project-reference'
import type { GitHubIssueType } from './mobile-tasks-view-state-types'

export type HostTaskProjectListResult = {
  projects: GitHubProjectSummary[]
  partialFailures: GitHubProjectPartialFailure[]
}

export type HostTaskProjectResolvePayload = {
  input: string
  host: string
}

export type HostTaskProjectResolveResult = {
  owner: string
  ownerType: GitHubProjectRef['ownerType']
  number: number
  title: string
  host?: string
  viewNumber?: number
}

export type HostTaskProjectTablePayload = GitHubProjectRef & {
  viewId: string
  queryOverride?: string
}

export type HostTaskProjectSlugPayload = {
  owner: string
  repo: string
  host: string
}

export type HostTaskProjectItemDetailPayload = HostTaskProjectSlugPayload & {
  number: number
  type: 'issue' | 'pr'
}

export type HostTaskProjectAssignableUsersPayload = HostTaskProjectSlugPayload & {
  seedLogins?: string[]
}

export type HostTaskProjectIssueType = GitHubIssueType
