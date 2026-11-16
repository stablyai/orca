// GH-AS-MEMBER: which GitHub GraphQL requests may carry a member's own user token. A member's token reaches
// more than the workspace repository, so it is used only for an allowlist of authorship mutations whose every
// target resolves to the workspace repository; everything else (queries, other mutations) stays on the App's
// installation token, which is scoped to that repository already. The document is parsed with graphql-js
// (never regex), and anything it can't read, or any shape it doesn't expect, is not a member request.
import { Kind, parse, type DocumentNode, type FieldNode, type SelectionSetNode, type ValueNode } from 'graphql'

/** Authorship mutations and the input fields naming what they act on (one of them must be present). */
export const MEMBER_MUTATIONS: Readonly<Record<string, readonly string[]>> = {
  createPullRequest: ['repositoryId'],
  updatePullRequest: ['pullRequestId'],
  markPullRequestReadyForReview: ['pullRequestId'],
  mergePullRequest: ['pullRequestId'],
  addComment: ['subjectId'],
  updateIssueComment: ['id'],
  addPullRequestReview: ['pullRequestId'],
  submitPullRequestReview: ['pullRequestId', 'pullRequestReviewId'],
  addPullRequestReviewThread: ['pullRequestId', 'pullRequestReviewId'],
  addPullRequestReviewThreadReply: ['pullRequestReviewThreadId', 'pullRequestReviewId'],
  addPullRequestReviewComment: ['pullRequestId', 'pullRequestReviewId']
}

/** One thing a mutation acts on: the repository itself, or a node (PR, issue, review, comment) to look up. */
export type MemberTarget = { kind: 'repository'; id: string } | { kind: 'node'; id: string }

export type MemberGraphqlVerdict =
  /** Not a member request: send it with the installation token, as before. */
  | { member: false; reason: string }
  /** Every root field is an allowlisted mutation; these targets must all resolve to the workspace repo. */
  | { member: true; targets: MemberTarget[]; fields: { name: string; input: Record<string, unknown> }[] }

type Variables = Record<string, unknown>

export function classifyGraphqlRequest(body: string): MemberGraphqlVerdict {
  // Review L4: a body with a repeated top-level key could parse differently here and at GitHub.
  if ((body.match(/"(query|variables|operationName)"\s*:/g) ?? []).length !== new Set(body.match(/"(query|variables|operationName)"\s*:/g) ?? []).size) {
    return { member: false, reason: 'duplicate_keys' }
  }
  let request: { query?: unknown; variables?: unknown; operationName?: unknown }
  try {
    request = JSON.parse(body) as typeof request
  } catch {
    return { member: false, reason: 'unreadable_body' }
  }
  if (typeof request.query !== 'string') {
    return { member: false, reason: 'no_query' }
  }
  let document: DocumentNode
  try {
    document = parse(request.query, { noLocation: true, maxTokens: 20_000 })
  } catch {
    return { member: false, reason: 'unparsable' }
  }
  const variables: Variables = request.variables && typeof request.variables === 'object' && !Array.isArray(request.variables) ? (request.variables as Variables) : {}
  const operations = document.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION)
  const name = typeof request.operationName === 'string' ? request.operationName : null
  const operation = name ? operations.find((candidate) => candidate.name?.value === name) : operations.length === 1 ? operations[0] : undefined
  if (!operation) {
    return { member: false, reason: 'ambiguous_operation' }
  }
  if (operation.operation !== 'mutation') {
    return { member: false, reason: 'not_a_mutation' }
  }
  if (operation.directives && operation.directives.length > 0) {
    return { member: false, reason: 'directives' }
  }
  // Review M1: GitHub applies a variable's default when the request omits it; that value would be invisible here.
  if (operation.variableDefinitions?.some((definition) => definition.defaultValue !== undefined)) {
    return { member: false, reason: 'variable_defaults' }
  }
  const fragments = new Map(
    document.definitions.flatMap((definition) => (definition.kind === Kind.FRAGMENT_DEFINITION ? [[definition.name.value, definition] as const] : []))
  )
  const fields: FieldNode[] = []
  const collect = (selections: SelectionSetNode, depth: number): string | null => {
    if (depth > 8) {
      return 'fragment_depth'
    }
    for (const selection of selections.selections) {
      if (selection.directives && selection.directives.length > 0) {
        return 'directives'
      }
      if (selection.kind === Kind.FIELD) {
        // __typename at the root changes nothing; every other root field must be allowlisted.
        if (selection.name.value !== '__typename') {
          fields.push(selection)
        }
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        if (selection.typeCondition && selection.typeCondition.name.value !== 'Mutation') {
          return 'fragment_type'
        }
        const nested = collect(selection.selectionSet, depth + 1)
        if (nested) {
          return nested
        }
      } else {
        const fragment = fragments.get(selection.name.value)
        if (!fragment || fragment.typeCondition.name.value !== 'Mutation') {
          return 'fragment_type'
        }
        const nested = collect(fragment.selectionSet, depth + 1)
        if (nested) {
          return nested
        }
      }
    }
    return null
  }
  const problem = collect(operation.selectionSet, 0)
  if (problem) {
    return { member: false, reason: problem }
  }
  if (fields.length === 0) {
    return { member: false, reason: 'empty' }
  }
  const targets: MemberTarget[] = []
  const resolved: { name: string; input: Record<string, unknown> }[] = []
  for (const field of fields) {
    const idFields = MEMBER_MUTATIONS[field.name.value]
    if (!idFields) {
      return { member: false, reason: 'mutation_not_allowlisted' }
    }
    const inputArg = field.arguments?.find((argument) => argument.name.value === 'input')
    if (!inputArg || (field.arguments?.length ?? 0) !== 1) {
      return { member: false, reason: 'unexpected_arguments' }
    }
    const input = resolveValue(inputArg.value, variables)
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { member: false, reason: 'unresolved_input' }
    }
    // Review L3: updatePullRequest's projectIds reach owner-level Projects outside the repository.
    if ((input as Record<string, unknown>).projectIds !== undefined) {
      return { member: false, reason: 'outside_repo_input' }
    }
    resolved.push({ name: field.name.value, input: input as Record<string, unknown> })
    const named = idFields.filter((key) => (input as Record<string, unknown>)[key] !== undefined && (input as Record<string, unknown>)[key] !== null)
    if (named.length === 0) {
      return { member: false, reason: 'no_target' }
    }
    for (const key of named) {
      const id = (input as Record<string, unknown>)[key]
      if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
        return { member: false, reason: 'bad_target' }
      }
      targets.push({ kind: key === 'repositoryId' ? 'repository' : 'node', id })
    }
  }
  return { member: true, targets, fields: resolved }
}

/**
 * Review M2: an approval never carries a member's identity, in any workspace (an agent approving as its
 * sender defeats "review by someone else"); it goes out on the installation token, so branch protection
 * still applies. Event compared case-insensitively, failing toward the installation token.
 */
export function approves(fields: readonly { name: string; input: Record<string, unknown> }[]): boolean {
  return fields.some(
    (field) =>
      (field.name === 'addPullRequestReview' || field.name === 'submitPullRequestReview') && String(field.input.event ?? '').toUpperCase() === 'APPROVE'
  )
}

/** Review M2: a merge carries a member's identity only in a workspace one person can use. */
export function merges(fields: readonly { name: string }[]): boolean {
  return fields.some((field) => field.name === 'mergePullRequest')
}

/** A literal or variable, as the server would see it. Unknown shapes resolve to undefined (not a member request). */
function resolveValue(value: ValueNode, variables: Variables): unknown {
  switch (value.kind) {
    case Kind.VARIABLE:
      return variables[value.name.value]
    case Kind.STRING:
    case Kind.ENUM:
      return value.value
    case Kind.INT:
    case Kind.FLOAT:
      return Number(value.value)
    case Kind.BOOLEAN:
      return value.value
    case Kind.NULL:
      return null
    case Kind.LIST:
      return value.values.map((item) => resolveValue(item, variables))
    case Kind.OBJECT:
      return Object.fromEntries(value.fields.map((field) => [field.name.value, resolveValue(field.value, variables)]))
    default:
      return undefined
  }
}

/** The repository a node belongs to, for the node kinds the allowlisted mutations act on. */
export const NODE_REPOSITORY_QUERY = `query OrcaNodeRepository($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequest { repository { id } }
    ... on Issue { repository { id } }
    ... on IssueComment { repository { id } }
    ... on PullRequestReview { pullRequest { repository { id } } }
    ... on PullRequestReviewThread { pullRequest { repository { id } } }
    ... on PullRequestReviewComment { pullRequest { repository { id } } }
  }
}`

/** The repository id in a NODE_REPOSITORY_QUERY answer, or null (unknown node, other type, error). */
export function repositoryIdOfNode(answer: unknown): string | null {
  const node = (answer as { data?: { node?: Record<string, unknown> | null } } | null)?.data?.node
  if (!node) {
    return null
  }
  const direct = (node.repository as { id?: unknown } | undefined)?.id
  if (typeof direct === 'string') {
    return direct
  }
  const viaPr = ((node.pullRequest as { repository?: { id?: unknown } } | undefined)?.repository)?.id
  return typeof viaPr === 'string' ? viaPr : null
}

/** What a member's out-of-repository mutation gets back: GraphQL's error shape, so gh prints it. */
export const MEMBER_OUT_OF_REPO_BODY = JSON.stringify({
  errors: [{ message: "Orca Cloud acts as you on GitHub only in this workspace's repository; this change targets something else." }]
})
