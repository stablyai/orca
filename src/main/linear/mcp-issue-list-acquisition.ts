import type { LinearClientOptions } from '@linear/sdk'
import { z } from 'zod'
import { ISSUE_FIELDS } from './issue-context-raw'
import { linearError } from './issue-context-errors'
import { readFetchResponseBytesWithinLimit } from '../../shared/fetch-response-body'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { getMainHttpClient } from '../network/http-client'

const nullableText = z.string().nullish()
const named = z.object({
  id: nullableText,
  name: nullableText,
  color: nullableText,
  type: nullableText
})
const issue = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string(),
  url: z.string(),
  description: nullableText,
  priority: z.number().finite().nullish(),
  estimate: z.number().finite().nullish(),
  dueDate: nullableText,
  branchName: nullableText,
  createdAt: nullableText,
  updatedAt: nullableText,
  state: named.nullish(),
  team: named.extend({ key: nullableText }).nullish(),
  project: named.nullish(),
  cycle: named.nullish(),
  assignee: z
    .object({ id: nullableText, displayName: nullableText, avatarUrl: nullableText })
    .nullish(),
  labels: z
    .object({
      nodes: z.array(named).max(50).optional(),
      pageInfo: z
        .object({
          hasNextPage: z.boolean().optional(),
          endCursor: nullableText
        })
        .optional()
    })
    .nullish()
})
const envelope = z.object({
  data: z.object({
    issues: z.object({
      nodes: z.array(issue),
      pageInfo: z.object({
        hasNextPage: z.boolean(),
        endCursor: nullableText
      })
    })
  })
})

export const LIST_ISSUES_QUERY = `query OrcaLinearListIssues(
  $first: Int!, $after: String, $filter: IssueFilter,
  $orderBy: PaginationOrderBy, $includeArchived: Boolean
) { issues(first: $first, after: $after, filter: $filter,
  orderBy: $orderBy, includeArchived: $includeArchived) {
  nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor }
} }`

export async function acquireIssueListPage(
  options: LinearClientOptions,
  variables: Record<string, unknown> & { first: number },
  signal: AbortSignal
): Promise<z.infer<typeof envelope>['data']['issues']> {
  const { apiKey, accessToken, apiUrl, headers: suppliedHeaders, ...init } = options
  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: accessToken
      ? accessToken.startsWith('Bearer ')
        ? accessToken
        : `Bearer ${accessToken}`
      : (apiKey ?? '')
  })
  new Headers(suppliedHeaders).forEach((value, name) => headers.set(name, value))
  const response = await getMainHttpClient().fetch(apiUrl ?? 'https://api.linear.app/graphql', {
    ...init,
    method: 'POST',
    headers,
    body: JSON.stringify({ query: LIST_ISSUES_QUERY, variables }),
    signal
  })
  if (!(response instanceof Response)) {
    throw linearError('linear_list_invalid_response', 'Linear requires a streaming response.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    const code =
      response.status === 401
        ? 'linear_auth_expired'
        : response.status === 403
          ? 'linear_permission_denied'
          : response.status === 429
            ? 'linear_rate_limited'
            : 'linear_network_error'
    const retryAfter = Number(response.headers.get('retry-after'))
    throw linearError(
      code,
      `Linear provider request failed (HTTP ${response.status}).`,
      Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= 86_400
        ? { retryAfterSeconds: retryAfter }
        : undefined
    )
  }
  const bytes = await readFetchResponseBytesWithinLimit(response, 4 * 1024 * 1024, signal)
  signal.throwIfAborted()
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw linearError('linear_list_invalid_response', 'Linear returned invalid UTF-8.')
  }
  assertJsonTextStructureWithinLimits(content, { structuralTokens: 250_000, nestingDepth: 32 })
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    throw linearError('linear_list_invalid_response', 'Linear returned invalid JSON.')
  }
  if (
    raw &&
    typeof raw === 'object' &&
    'errors' in raw &&
    (!Array.isArray(raw.errors) || raw.errors.length > 0)
  ) {
    const firstError = Array.isArray(raw.errors) ? raw.errors[0] : undefined
    const type = firstError?.extensions?.type ?? firstError?.message
    const code =
      type === 'AuthenticationError'
        ? 'linear_auth_expired'
        : type === 'Forbidden'
          ? 'linear_permission_denied'
          : type === 'Ratelimited'
            ? 'linear_rate_limited'
            : 'linear_network_error'
    throw linearError(code, 'Linear returned a GraphQL error.')
  }
  const parsed = envelope.safeParse(raw)
  if (!parsed.success || parsed.data.data.issues.nodes.length > variables.first) {
    throw linearError('linear_list_invalid_response', 'Linear returned an invalid issue page.')
  }
  return parsed.data.data.issues
}
