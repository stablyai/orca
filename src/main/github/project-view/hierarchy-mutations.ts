// Why: extracted from hierarchy.ts to stay under the repo's oxlint max-lines
// cap — the write path (id resolution + the 3 GraphQL mutations) is a
// cohesive, self-contained concern, separate from the read path
// (getIssueHierarchy + normalizers) and validation that stay in
// hierarchy.ts. Only a one-directional import (this file → hierarchy.ts)
// keeps the two files acyclic; consumers of the mutation functions import
// directly from here (see project-view.ts's barrel and hierarchy.test.ts)
// rather than through hierarchy.ts as a re-export, to avoid a circular
// module dependency.
import { driftError, runGraphql, type GraphqlVars } from './internals'
import {
  normalizeSummary,
  validateAddSubIssueArgs,
  validateRemoveSubIssueArgs,
  validateReprioritizeSubIssueArgs,
  type RawSubIssuesSummary
} from './hierarchy'
import type {
  AddSubIssueBySlugArgs,
  AddSubIssueBySlugResult,
  GitHubProjectViewError,
  RemoveSubIssueBySlugArgs,
  RemoveSubIssueBySlugResult,
  ReprioritizeSubIssueBySlugArgs,
  ReprioritizeSubIssueBySlugResult
} from '../../../shared/github-project-types'

// ─── Mutations (GraphQL — see plan spike: addSubIssue/removeSubIssue/
// reprioritizeSubIssue exist as GraphQL mutations, not REST-only as the
// RFC's schema excerpt left ambiguous. Confirmed live 2026-07-15.) ──────

// Why: pure and exported for testing — dynamically aliases one `issue(number:)`
// field per distinct number so a single round trip resolves every node ID a
// mutation needs (issue + sub-issue + optional before/after sibling), same
// repo only (v1 scope — see plan's open question #3).
export function buildResolveIssueIdsQuery(count: number): string {
  const varsDecl = Array.from({ length: count }, (_, i) => `$n${i}: Int!`).join(', ')
  const fields = Array.from(
    { length: count },
    (_, i) => `    i${i}: issue(number: $n${i}) { id }`
  ).join('\n')
  return `
query ResolveIssueIds($owner: String!, $repo: String!, ${varsDecl}) {
  repository(owner: $owner, name: $repo) {
${fields}
  }
}
`
}

type ResolveIssueIdsResponse = {
  repository: Record<string, { id?: string } | null> | null
}

async function resolveIssueNodeIds(
  owner: string,
  repo: string,
  numbers: number[]
): Promise<{ ok: true; ids: Map<number, string> } | { ok: false; error: GitHubProjectViewError }> {
  const query = buildResolveIssueIdsQuery(numbers.length)
  const vars: GraphqlVars = { owner, repo }
  numbers.forEach((n, i) => {
    vars[`n${i}`] = n
  })
  const res = await runGraphql<ResolveIssueIdsResponse>(query, vars)
  if (!res.ok) {
    return { ok: false, error: res.error }
  }
  const repository = res.data.repository
  if (!repository) {
    return { ok: false, error: { type: 'not_found', message: 'Repository not found.' } }
  }
  const ids = new Map<number, string>()
  for (let i = 0; i < numbers.length; i++) {
    const alias = repository[`i${i}`]
    if (!alias || typeof alias.id !== 'string') {
      return { ok: false, error: { type: 'not_found', message: `Issue #${numbers[i]} not found.` } }
    }
    ids.set(numbers[i], alias.id)
  }
  return { ok: true, ids }
}

const ADD_SUB_ISSUE_MUTATION = `
mutation AddSubIssue($issueId: ID!, $subIssueId: ID!) {
  addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
    issue { subIssuesSummary { total completed percentCompleted } }
  }
}
`

export async function addSubIssueBySlug(
  args: AddSubIssueBySlugArgs
): Promise<AddSubIssueBySlugResult> {
  const validation = validateAddSubIssueArgs(args)
  if (!validation.ok) {
    return validation
  }
  const resolved = await resolveIssueNodeIds(args.owner, args.repo, [
    args.number,
    args.subIssueNumber
  ])
  if (!resolved.ok) {
    return resolved
  }
  const issueId = resolved.ids.get(args.number)
  const subIssueId = resolved.ids.get(args.subIssueNumber)
  if (!issueId || !subIssueId) {
    return { ok: false, error: driftError('resolved issue id missing') }
  }
  const res = await runGraphql<{
    addSubIssue: { issue: { subIssuesSummary: RawSubIssuesSummary } }
  }>(ADD_SUB_ISSUE_MUTATION, { issueId, subIssueId })
  if (!res.ok) {
    return { ok: false, error: res.error }
  }
  const summary = normalizeSummary(res.data.addSubIssue.issue.subIssuesSummary)
  if (!summary) {
    return { ok: false, error: driftError('addSubIssue response missing subIssuesSummary') }
  }
  return { ok: true, subIssuesSummary: summary }
}

const REMOVE_SUB_ISSUE_MUTATION = `
mutation RemoveSubIssue($issueId: ID!, $subIssueId: ID!) {
  removeSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
    issue { subIssuesSummary { total completed percentCompleted } }
  }
}
`

export async function removeSubIssueBySlug(
  args: RemoveSubIssueBySlugArgs
): Promise<RemoveSubIssueBySlugResult> {
  const validation = validateRemoveSubIssueArgs(args)
  if (!validation.ok) {
    return validation
  }
  const resolved = await resolveIssueNodeIds(args.owner, args.repo, [
    args.number,
    args.subIssueNumber
  ])
  if (!resolved.ok) {
    return resolved
  }
  const issueId = resolved.ids.get(args.number)
  const subIssueId = resolved.ids.get(args.subIssueNumber)
  if (!issueId || !subIssueId) {
    return { ok: false, error: driftError('resolved issue id missing') }
  }
  const res = await runGraphql<{
    removeSubIssue: { issue: { subIssuesSummary: RawSubIssuesSummary } }
  }>(REMOVE_SUB_ISSUE_MUTATION, { issueId, subIssueId })
  if (!res.ok) {
    return { ok: false, error: res.error }
  }
  const summary = normalizeSummary(res.data.removeSubIssue.issue.subIssuesSummary)
  if (!summary) {
    return { ok: false, error: driftError('removeSubIssue response missing subIssuesSummary') }
  }
  return { ok: true, subIssuesSummary: summary }
}

// Why: conditional before/after selection via string interpolation — same
// pattern as project-view.ts's itemContentSelection(includeParent), so a
// caller that omits both moves the sub-issue to the end of its parent's
// list (GitHub's own default) without declaring unused GraphQL variables.
function reprioritizeSubIssueMutation(hasBefore: boolean, hasAfter: boolean): string {
  const beforeVar = hasBefore ? ', $beforeId: ID!' : ''
  const afterVar = hasAfter ? ', $afterId: ID!' : ''
  const beforeArg = hasBefore ? ', beforeId: $beforeId' : ''
  const afterArg = hasAfter ? ', afterId: $afterId' : ''
  return `
mutation ReprioritizeSubIssue($issueId: ID!, $subIssueId: ID!${beforeVar}${afterVar}) {
  reprioritizeSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId${beforeArg}${afterArg} }) {
    clientMutationId
  }
}
`
}

export async function reprioritizeSubIssueBySlug(
  args: ReprioritizeSubIssueBySlugArgs
): Promise<ReprioritizeSubIssueBySlugResult> {
  const validation = validateReprioritizeSubIssueArgs(args)
  if (!validation.ok) {
    return validation
  }
  const numbersToResolve = [args.number, args.subIssueNumber]
  if (args.beforeNumber !== undefined) {
    numbersToResolve.push(args.beforeNumber)
  }
  if (args.afterNumber !== undefined) {
    numbersToResolve.push(args.afterNumber)
  }
  const resolved = await resolveIssueNodeIds(args.owner, args.repo, numbersToResolve)
  if (!resolved.ok) {
    return resolved
  }
  const issueId = resolved.ids.get(args.number)
  const subIssueId = resolved.ids.get(args.subIssueNumber)
  const beforeId = args.beforeNumber !== undefined ? resolved.ids.get(args.beforeNumber) : undefined
  const afterId = args.afterNumber !== undefined ? resolved.ids.get(args.afterNumber) : undefined
  if (!issueId || !subIssueId) {
    return { ok: false, error: driftError('resolved issue id missing') }
  }
  const vars: GraphqlVars = { issueId, subIssueId }
  if (beforeId) {
    vars.beforeId = beforeId
  }
  if (afterId) {
    vars.afterId = afterId
  }
  const query = reprioritizeSubIssueMutation(beforeId !== undefined, afterId !== undefined)
  const res = await runGraphql<{ reprioritizeSubIssue: { clientMutationId: string | null } }>(
    query,
    vars
  )
  if (!res.ok) {
    return { ok: false, error: res.error }
  }
  return { ok: true }
}
