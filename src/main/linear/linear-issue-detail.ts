import type { LinearIssue } from '../../shared/linear/issue-types'
import type { LinearClientForWorkspace } from './client'
import { isAuthError } from './client'
import { ISSUE_QUERY } from './issue-context/raw'
import type { LinearIssueNode, LinearRawVariables } from './linear-issue-query-documents'
import { mapRawIssueForWorkspace } from './linear-issue-query-support'
import { loadLinearSdk } from './linear-sdk'

type LinearIssueDetailNode = LinearIssueNode & {
  project?: { id: string; name: string; url?: string | null; color?: string | null } | null
  children?: { nodes?: NonNullable<LinearIssue['subIssues']> } | null
}
type LinearIssueDetailResponse = { issue?: LinearIssueDetailNode | null }

const OPTIONAL_RELATIONS = {
  state: true,
  team: true,
  assignee: true,
  project: true,
  labels: true,
  children: true
}

function isOptionalRelation(field: string | undefined): field is keyof typeof OPTIONAL_RELATIONS {
  return field !== undefined && Object.hasOwn(OPTIONAL_RELATIONS, field)
}

export async function readLinearIssueDetail(
  entry: LinearClientForWorkspace,
  id: string
): Promise<LinearIssue | null> {
  let issue: LinearIssueDetailNode | null | undefined
  try {
    const result = await entry.client.client.rawRequest<
      LinearIssueDetailResponse,
      LinearRawVariables
    >(ISSUE_QUERY, { id, includeDrawerFields: true })
    issue = result.data?.issue
  } catch (error) {
    if (
      !(error instanceof loadLinearSdk().LinearError) ||
      isAuthError(error) ||
      error.errors?.some(({ type }) => type === 'AuthenticationError') ||
      error.status !== 200 ||
      !error.errors?.length ||
      !error.errors.every(({ path }) => path?.[0] === 'issue' && isOptionalRelation(path[1]))
    ) {
      throw error
    }
    // SAFETY: SDK partial data uses the same provider schema as this request's successful response.
    const data = error.data as LinearIssueDetailResponse | undefined
    issue = data?.issue && { ...data.issue }
    if (issue) {
      // Keep the former SDK mapper's whole-relation failure isolation.
      for (const { path } of error.errors) {
        const field = path?.[1]
        if (isOptionalRelation(field)) {
          delete issue[field]
        }
      }
    }
  }
  if (!issue) {
    return null
  }
  return {
    ...mapRawIssueForWorkspace(entry, issue),
    updatedAt: new Date(issue.updatedAt).toISOString(),
    project: issue.project
      ? {
          id: issue.project.id,
          name: issue.project.name,
          url: issue.project.url ?? undefined,
          color: issue.project.color ?? undefined
        }
      : undefined,
    subIssues: issue.children?.nodes
  }
}
