import {
  assertPositiveInt,
  projectGhExecOptions,
  runGraphql,
  validateSlugArgs,
  type GraphqlVars
} from './internals'
import type { GitHubProjectMutationResult } from '../../../shared/github/project-result-types'
import type { UpdateIssueTypeBySlugArgs } from '../../../shared/github/project-request-types'

export async function updateIssueTypeBySlug(
  args: UpdateIssueTypeBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const validation = validateSlugArgs(args.owner, args.repo)
  if (!validation.ok) {
    return validation
  }
  const number = assertPositiveInt(args.number, 'number')
  if (!number.ok) {
    return { ok: false, error: number.error }
  }
  const lookup = await runGraphql<{
    repository?: { issue?: { id?: string } | null } | null
  }>(
    `query($owner:String!, $repo:String!, $num:Int!) {
       repository(owner:$owner, name:$repo) { issue(number:$num) { id } }
     }`,
    { owner: args.owner, repo: args.repo, num: args.number },
    projectGhExecOptions(args.host)
  )
  if (!lookup.ok) {
    return { ok: false, error: lookup.error }
  }
  const issueId = lookup.data.repository?.issue?.id
  if (!issueId) {
    return { ok: false, error: { type: 'not_found', message: 'Issue not found.' } }
  }
  const query = args.issueTypeId
    ? `mutation($issueId:ID!, $issueTypeId:ID!) {
         updateIssueIssueType(input: { issueId: $issueId, issueTypeId: $issueTypeId }) {
           issue { id }
         }
       }`
    : `mutation($issueId:ID!) {
         updateIssueIssueType(input: { issueId: $issueId, issueTypeId: null }) {
           issue { id }
         }
       }`
  const vars: GraphqlVars = args.issueTypeId
    ? { issueId, issueTypeId: args.issueTypeId }
    : { issueId }
  const result = await runGraphql<unknown>(query, vars, projectGhExecOptions(args.host))
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}
