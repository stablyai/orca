// APPROVALS-REFUSED: no approval of a pull request ever leaves a workspace. An approval sent with the App's
// installation token very likely counts toward a branch's required reviews, so anything in the VM could open a PR
// as the owner, approve it as the App, and merge past "requires 1 approval". Approvals have to be a person's, on
// GitHub. Refused on every api.github.com route the egress proxy swaps (the owner's and the App's), and in firewall
// mode those requests are forwarded to the proxy for this check instead of being swapped by the firewall.
import { Kind, parse, type DocumentNode, type FragmentDefinitionNode, type SelectionSetNode, type ValueNode } from 'graphql'

const pathOfEarly = (path: string) => (path.split('?')[0] ?? '').toLowerCase()
export const APPROVAL_REFUSED_MESSAGE =
  "Approvals have to be done by a person on GitHub, not from an Orca Cloud workspace. Open the pull request on github.com to approve it."

/** The answer a refused approval gets: GitHub-shaped JSON for REST, a GraphQL error for /graphql. */
export function approvalRefusal(path: string): { deny: string; answer: { status: number; contentType: string; body: string } } {
  const graphql = pathOfEarly(path) === '/graphql'
  return {
    deny: 'approval_refused',
    answer: {
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify(graphql ? { errors: [{ type: 'FORBIDDEN', message: APPROVAL_REFUSED_MESSAGE }] } : { message: APPROVAL_REFUSED_MESSAGE })
    }
  }
}

/** Review G2's refusal: GitHub-shaped, says what to do. */
export const UNNORMALIZED_WRITE_REFUSAL = {
  deny: 'path_not_allowed',
  answer: { status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Orca Cloud refused this request: its path has escapes or empty or dot segments. Send the plain path.' }) }
}

/** A pull request review, or a pending review's submission (case-insensitive, optional trailing slash). */
export const REVIEW_PATH = /\/pulls\/\d+\/reviews(\/\d+\/events)?\/?$/i
/** Dismissing a review (unblocks a merge a REQUEST_CHANGES review was holding). */
const DISMISSAL_PATH = /\/pulls\/\d+\/reviews\/\d+\/dismissals\/?$/i
/** Approving a fork PR's workflow run, or an environment deployment waiting for review. */
const RUN_APPROVAL_PATH = /\/actions\/runs\/\d+\/approve\/?$/i
const PENDING_DEPLOYMENTS_PATH = /\/actions\/runs\/\d+\/pending_deployments\/?$/i

const pathOf = (path: string) => (path.split('?')[0] ?? '').toLowerCase()
const writes = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())

/**
 * Review G2: a write whose path GitHub would normalize differently than these checks read it (percent-escapes, empty
 * or dot segments) is refused outright, so `/repos/o/r/pulls/7/%72eviews` or `/x/%2e%2e/repos/...` can't slip past.
 */
export function unnormalizedWrite(method: string, path: string): boolean {
  if (!writes(method)) {
    return false
  }
  const raw = path.split('?')[0] ?? ''
  return raw.includes('%') || raw.includes('//') || raw.split('/').some((segment) => segment === '.' || segment === '..')
}

/** Requests whose body the approval check must read (the proxy reads it as text only for these). */
export function approvalCheckReadsBody(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'POST') {
    return false
  }
  const pathname = pathOf(path)
  return pathname === '/graphql' || REVIEW_PATH.test(pathname) || PENDING_DEPLOYMENTS_PATH.test(pathname)
}

/** Is this request an approval, or approval-shaped (REST or GraphQL)? Anything unreadable on those counts as one. */
export function requestApproves(request: { method: string; path: string; body: string | null }): boolean {
  const method = request.method.toUpperCase()
  const pathname = pathOf(request.path)
  if (method === 'PUT' && DISMISSAL_PATH.test(pathname)) {
    return true
  }
  if (method === 'POST' && RUN_APPROVAL_PATH.test(pathname)) {
    return true
  }
  if (!approvalCheckReadsBody(request.method, request.path)) {
    return false
  }
  if (pathname === '/graphql') {
    return graphqlApproves(request.body)
  }
  if (PENDING_DEPLOYMENTS_PATH.test(pathname)) {
    return deploymentApproves(request.body)
  }
  return restApproves(request.body)
}

function deploymentApproves(body: string | null): boolean {
  if (body === null) {
    return true
  }
  try {
    const state = (JSON.parse(body) as { state?: unknown } | null)?.state
    return String(state ?? '').toLowerCase() !== 'rejected'
  } catch {
    return true
  }
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
/** Approval-shaped mutations refused whatever their input (review G4). */
const ALWAYS_REFUSED_MUTATIONS = new Set(['dismissPullRequestReview'])
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
    // Review G3: unreadable (a Content-Encoding'd body never parses as JSON): refused.
    return true
  }
  // Batched requests: any of them.
  const requests = Array.isArray(parsed) ? parsed : [parsed]
  return requests.some((request) => requestBodyApproves(request))
}

/** Review G3: a query graphql-js can't parse but GitHub might: refused if it names a review mutation at all. */
function mentionsReviewMutation(text: string): boolean {
  return /addPullRequestReview|submitPullRequestReview|dismissPullRequestReview/i.test(text)
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
    return mentionsReviewMutation(query)
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
      if (ALWAYS_REFUSED_MUTATIONS.has(selection.name.value)) {
        return true
      }
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
