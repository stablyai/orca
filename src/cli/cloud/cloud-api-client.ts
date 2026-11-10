// Private build only: a small HTTPS client for the Orca Cloud public API (/v1/…). Every failure
// becomes a RuntimeClientError with a stable `cloud_*` code and next steps, so `--json` callers
// (agents) and people both get an actionable message.
import { RuntimeClientError } from '../runtime/types'
import { cloudApiError, type CloudRequestIntent } from './cloud-api-errors'
import { jsonFields, type CloudCredentials } from './cloud-credentials'

export { cloudApiError, type CloudApiErrorBody } from './cloud-api-errors'

export type CloudFetch = (input: string, init: RequestInit) => Promise<Response>

const DEFAULT_TIMEOUT_MS = 60_000

export class CloudApiClient {
  constructor(
    readonly credentials: CloudCredentials,
    private readonly fetchImpl: CloudFetch = fetch
  ) {}

  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: {
      body?: unknown
      timeoutMs?: number
      query?: Record<string, string | undefined>
      /** Picks create-time error copy ("Nothing was created") over "Your files are safe". */
      intent?: CloudRequestIntent
    } = {}
  ): Promise<T> {
    const url = new URL(`${this.credentials.apiUrl}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, value)
      }
    }
    let response: Response
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${this.credentials.token}`,
          accept: 'application/json',
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {})
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        // Why: a redirect could forward the bearer token to another origin.
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      })
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      throw new RuntimeClientError(
        'cloud_unreachable',
        timedOut
          ? `Orca Cloud didn't answer within ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} seconds.`
          : `Couldn't reach Orca Cloud at ${this.credentials.apiUrl}.`,
        {
          apiUrl: this.credentials.apiUrl,
          request: `${method} ${path}`,
          cause: error instanceof Error ? error.message : String(error),
          nextSteps: this.credentials.token.startsWith('orca_ws_')
            ? [
                "Inside a cloud workspace, Orca Cloud must be on the sandbox's egress allowlist. Restart the workspace, then try again."
              ]
            : ['Check your network and ORCA_CLOUD_API_URL, then try again.']
        }
      )
    }
    const text = await response.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
    }
    if (!response.ok) {
      throw cloudApiError(response.status, jsonFields(body), {
        credentials: this.credentials,
        retryAfter: response.headers.get('retry-after'),
        intent: options.intent,
        path
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the client's typed boundary; each caller names the control-plane response shape it reads
    return body as T
  }
}
