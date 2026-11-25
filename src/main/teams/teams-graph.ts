// Microsoft Graph calls for a Teams verb, as the signed-in person. A refused token is renewed once;
// a throttle is waited out once; anything else comes back as one sentence to act on.
import { z } from 'zod'
import { teamsAccount, type TeamsTokenDeps } from './teams-account-tokens'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const REQUEST_TIMEOUT_MS = 20_000
const MAX_RETRY_AFTER_MS = 10_000

export class TeamsGraphError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'TeamsGraphError'
  }
}

const GraphErrorBody = z.object({
  error: z.object({ code: z.string().optional(), message: z.string().optional() })
})

function refusal(status: number, body: unknown): TeamsGraphError {
  const error = GraphErrorBody.safeParse(body).data?.error
  const code = error?.code ?? ''
  const said = error?.message?.split('\n')[0]?.slice(0, 300) ?? ''
  const detail = said ? ` Microsoft said: ${said}` : code ? ` (${code})` : ''
  if (status === 403) {
    return new TeamsGraphError(
      status,
      `Teams refused this: you aren't a member there, or your sign-in lacks the permission.${detail}`
    )
  }
  if (status === 404) {
    return new TeamsGraphError(
      status,
      `Teams has no such chat, channel or message for you.${detail}`
    )
  }
  return new TeamsGraphError(status, `Microsoft Graph answered ${status}.${detail}`)
}

/** A next page Graph links to; only ever on Graph itself, so the token goes nowhere else. */
function graphUrl(pathOrLink: string): string {
  if (pathOrLink.startsWith('/')) {
    return `${GRAPH}${pathOrLink}`
  }
  if (!pathOrLink.startsWith(`${GRAPH}/`)) {
    throw new TeamsGraphError(0, 'Microsoft Graph linked to a page outside Graph; it was not read.')
  }
  return pathOrLink
}

export type TeamsGraph = {
  /** Each answer is checked against `shape`; one that doesn't fit is refused, not guessed at. */
  get: <T>(pathOrLink: string, shape: z.ZodType<T>) => Promise<T>
  post: <T>(path: string, body: unknown, shape: z.ZodType<T>) => Promise<T>
  /** What the signed-in person allowed, and who they are. */
  account: () => Promise<{ userId: string; grantedScopes: string[] }>
}

export function teamsGraph(deps: TeamsTokenDeps): TeamsGraph {
  const send = async <T>(
    method: 'GET' | 'POST',
    target: string,
    shape: z.ZodType<T>,
    body?: unknown
  ): Promise<T> => {
    const url = graphUrl(target)
    let renewed = false
    let waited = false
    for (;;) {
      const { accessToken } = await teamsAccount(deps, renewed)
      const response = await deps.http(url, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      const answer: unknown = await response.json().catch(() => null)
      if (response.ok) {
        const read = shape.safeParse(answer)
        if (!read.success) {
          throw new TeamsGraphError(
            response.status,
            'Microsoft Graph answered in a shape Orca does not know.'
          )
        }
        return read.data
      }
      if (response.status === 401 && !renewed) {
        renewed = true
        continue
      }
      const retryAfterMs = Number(response.headers.get('retry-after') ?? '1') * 1000
      if (
        // A 503 may have done the post; only a read is sent again after one.
        (response.status === 429 || (response.status === 503 && method === 'GET')) &&
        !waited &&
        retryAfterMs <= MAX_RETRY_AFTER_MS
      ) {
        waited = true
        await new Promise((resolve) => setTimeout(resolve, Math.max(retryAfterMs, 0)))
        continue
      }
      throw refusal(response.status, answer)
    }
  }
  return {
    get: (pathOrLink, shape) => send('GET', pathOrLink, shape),
    post: (path, body, shape) => send('POST', path, shape, body),
    account: async () => {
      const record = await teamsAccount(deps)
      return { userId: record.userId, grantedScopes: record.grantedScopes }
    }
  }
}
