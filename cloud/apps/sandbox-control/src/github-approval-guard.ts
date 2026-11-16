// APPROVALS-REFUSED: no approval of a pull request ever leaves a workspace. An approval sent with the App's
// installation token very likely counts toward a branch's required reviews, so anything in the VM could open a PR
// as the owner, approve it as the App, and merge past "requires 1 approval". Approvals have to be a person's, on
// GitHub. Refused on every api.github.com route the egress proxy swaps (the owner's and the App's), and in firewall
// mode those requests are forwarded to the proxy for this check instead of being swapped by the firewall.
import { Kind, parse, type DocumentNode, type FragmentDefinitionNode, type SelectionSetNode, type ValueNode } from 'graphql'

export const APPROVAL_REFUSED_MESSAGE =
  "Approvals have to be done by a person on GitHub, not from an Orca Cloud workspace. Open the pull request on github.com to approve it."

/** The answer a refused approval gets: GitHub-shaped JSON for REST, a GraphQL error for /graphql. */
export function approvalRefusal(path: string): { deny: string; answer: { status: number; contentType: string; body: string } } {
  const graphql = (path.split('?')[0] ?? '') === '/graphql'
  return {
    deny: 'approval_refused',
    answer: {
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify(graphql ? { errors: [{ type: 'FORBIDDEN', message: APPROVAL_REFUSED_MESSAGE }] } : { message: APPROVAL_REFUSED_MESSAGE })
    }
  }
}

/** A pull request review, or a pending review's submission (case-insensitive, optional trailing slash). */
export const REVIEW_PATH = /\/pulls\/\d+\/reviews(\/\d+\/events)?\/?$/i

/** Requests whose body the approval check must read (the proxy reads it as text only for these). */
export function approvalCheckReadsBody(method: string, path: string): boolean {
  const pathname = path.split('?')[0] ?? ''
  return method.toUpperCase() === 'POST' && (pathname === '/graphql' || REVIEW_PATH.test(pathname))
}

/** Is this request an approval (REST or GraphQL)? Anything unreadable on those endpoints counts as one. */
export function requestApproves(request: { method: string; path: string; body: string | null }): boolean {
  if (!approvalCheckReadsBody(request.method, request.path)) {
    return false
  }
  const pathname = request.path.split('?')[0] ?? ''
  return pathname === '/graphql' ? graphqlApproves(request.body) : restApproves(request.body)
}

function restApproves(body: string | null): boolean {
  if (body === null) {
    return true
  }
  try {
    const event = (JSON.parse(body) as { event?: unknown } | null)?.event
    return String(event ?? '').toUpperCase() === 'APPROVE'
  } catch {
    return true
  }
}

const REVIEW_MUTATIONS = new Set(['addPullRequestReview', 'submitPullRequestReview'])
type Variables = Record<string, unknown>

/** Fails toward "approves": an unreadable body, or a review mutation whose event can't be resolved. */
export function graphqlApproves(body: string | null): boolean {
  if (body === null) {
    return true
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return mentionsReviewApproval(body)
  }
  // Batched requests: any of them.
  const requests = Array.isArray(parsed) ? parsed : [parsed]
  return requests.some((request) => requestBodyApproves(request))
}

function mentionsReviewApproval(text: string): boolean {
  return /addPullRequestReview|submitPullRequestReview/.test(text) && /approve/i.test(text)
}

function requestBodyApproves(request: unknown): boolean {
  if (!request || typeof request !== 'object') {
    return false
  }
  const { query, variables } = request as { query?: unknown; variables?: unknown }
  if (typeof query !== 'string') {
    return false
  }
  let document: DocumentNode
  try {
    document = parse(query, { noLocation: true, maxTokens: 20_000 })
  } catch {
    return mentionsReviewApproval(query)
  }
  const vars: Variables = variables && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Variables) : {}
  const fragments = new Map<string, FragmentDefinitionNode>()
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition)
    }
  }
  // Every mutation operation, not only the one named: a server picking another one must not slip through.
  return document.definitions.some((definition) => {
    if (definition.kind !== Kind.OPERATION_DEFINITION || definition.operation !== 'mutation') {
      return false
    }
    // A variable's default counts as its value when the request doesn't send one (`$e: … = APPROVE`).
    const withDefaults: Variables = { ...vars }
    for (const variable of definition.variableDefinitions ?? []) {
      const key = variable.variable.name.value
      if (withDefaults[key] === undefined && variable.defaultValue) {
        withDefaults[key] = resolveValue(variable.defaultValue, {})
      }
    }
    return selectionsApprove(definition.selectionSet, fragments, withDefaults, new Set())
  })
}

function selectionsApprove(set: SelectionSetNode, fragments: ReadonlyMap<string, FragmentDefinitionNode>, vars: Variables, seen: Set<string>): boolean {
  for (const selection of set.selections) {
    if (selection.kind === Kind.FIELD) {
      if (REVIEW_MUTATIONS.has(selection.name.value) && fieldApproves(selection.name.value, selection.arguments ?? [], vars)) {
        return true
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      if (selectionsApprove(selection.selectionSet, fragments, vars, seen)) {
        return true
      }
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value
      const fragment = fragments.get(name)
      if (!seen.has(name) && fragment) {
        seen.add(name)
        if (selectionsApprove(fragment.selectionSet, fragments, vars, seen)) {
          return true
        }
      }
    }
  }
  return false
}

function fieldApproves(name: string, args: readonly { name: { value: string }; value: ValueNode }[], vars: Variables): boolean {
  const input = args.find((arg) => arg.name.value === 'input')
  const resolved = input ? resolveValue(input.value, vars) : undefined
  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
    // Unresolvable input: count it as an approval (fail closed).
    return true
  }
  const event = (resolved as { event?: unknown }).event
  if (event === undefined || event === null) {
    // addPullRequestReview without an event starts a pending review; a submission always needs one.
    return name === 'submitPullRequestReview'
  }
  return typeof event !== 'string' || event.toUpperCase() === 'APPROVE'
}

function resolveValue(value: ValueNode, vars: Variables): unknown {
  switch (value.kind) {
    case Kind.VARIABLE:
      return vars[value.name.value]
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
      return value.values.map((item) => resolveValue(item, vars))
    case Kind.OBJECT:
      return Object.fromEntries(value.fields.map((field) => [field.name.value, resolveValue(field.value, vars)]))
    default:
      return undefined
  }
}
