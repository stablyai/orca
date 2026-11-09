// Private build only: a small HTTPS client for the Orca Cloud public API (/v1/…). Every failure
// becomes a RuntimeClientError with a stable `cloud_*` code and next steps, so `--json` callers
// (agents) and people both get an actionable message.
import { RuntimeClientError } from '../runtime/types'
import type { CloudCredentials } from './cloud-credentials'

export type CloudFetch = (input: string, init: RequestInit) => Promise<Response>

export type CloudApiErrorBody = { error?: unknown; reason?: unknown }

const DEFAULT_TIMEOUT_MS = 60_000

export class CloudApiClient {
  constructor(
    readonly credentials: CloudCredentials,
    private readonly fetchImpl: CloudFetch = fetch
  ) {}

  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: { body?: unknown; timeoutMs?: number; query?: Record<string, string | undefined> } = {}
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
          ? `Orca Cloud did not answer ${method} ${path} within ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s.`
          : `Could not reach Orca Cloud at ${this.credentials.apiUrl}: ${error instanceof Error ? error.message : String(error)}`,
        {
          apiUrl: this.credentials.apiUrl,
          nextSteps: this.credentials.token.startsWith('orca_ws_')
            ? [
                "Inside an Orca Cloud workspace the control plane must be on the VM's egress allowlist; restart the workspace after a control-plane update."
              ]
            : ['Check the network and the control-plane URL, then retry.']
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
      throw cloudApiError(response.status, (body ?? {}) as CloudApiErrorBody, {
        credentials: this.credentials,
        retryAfter: response.headers.get('retry-after')
      })
    }
    return body as T
  }
}

/** Maps a control-plane error response to the CLI's error. Exported for tests. */
export function cloudApiError(
  status: number,
  body: CloudApiErrorBody,
  context: {
    credentials: Pick<CloudCredentials, 'source' | 'token' | 'path'>
    retryAfter?: string | null
  }
): RuntimeClientError {
  const code = typeof body.error === 'string' ? body.error : `http_${status}`
  const reason = typeof body.reason === 'string' ? body.reason : null
  const data = (nextSteps: string[], extra: Record<string, unknown> = {}) => ({
    status,
    apiError: code,
    ...(reason ? { reason } : {}),
    ...extra,
    ...(nextSteps.length > 0 ? { nextSteps } : {})
  })
  const inVm = context.credentials.token.startsWith('orca_ws_')
  if (status === 401) {
    return new RuntimeClientError(
      'cloud_unauthorized',
      inVm
        ? 'Orca Cloud rejected this workspace token (it is replaced at each boot and revoked on sleep or destroy).'
        : 'Orca Cloud rejected the token: it is expired, revoked or for another control plane.',
      data(
        inVm
          ? ['Restart the workspace to get a fresh token, or set ORCA_CLOUD_TOKEN to an API key.']
          : context.credentials.source === 'env'
            ? ['Set ORCA_CLOUD_TOKEN to a valid API key or session token.']
            : ['Run `orca cloud login --token <token>` with a fresh API key or session token.']
      )
    )
  }
  if (status === 403 && reason === 'vm_cli_disabled') {
    return new RuntimeClientError(
      'cloud_vm_cli_disabled',
      'In-workspace CLI access is turned off for this Orca Cloud organization, so this workspace cannot call Orca Cloud.',
      data([
        'Ask an organization owner or admin to turn on in-workspace CLI access in Orca Cloud settings (PUT /v1/settings {"vmCliEnabled": true}).'
      ])
    )
  }
  if (status === 403 && reason === 'own_workspace') {
    return new RuntimeClientError(
      'cloud_forbidden',
      'A workspace cannot sleep, archive or destroy itself; pick another workspace.',
      data([])
    )
  }
  if (status === 403 && code === 'insufficient_scope') {
    return new RuntimeClientError(
      'cloud_forbidden',
      `This token lacks the ${reason ?? 'required'} scope.`,
      data(['Create an API key with that scope in Orca Cloud settings and log in with it.'])
    )
  }
  if (status === 403) {
    const why: Record<string, string> = {
      session_required: 'This needs a signed-in Orca session, not an API key or workspace token.',
      admin_required: 'Only an organization owner or admin can do this.'
    }
    return new RuntimeClientError(
      'cloud_forbidden',
      (reason && why[reason]) || `Orca Cloud refused the request (${reason ?? code}).`,
      data([])
    )
  }
  if (status === 404) {
    return new RuntimeClientError(
      'cloud_not_found',
      inVm
        ? 'Not found. A workspace token sees only its own workspace and the workspaces it created.'
        : 'Not found in this Orca Cloud account.',
      data(['Run `orca cloud workspace list` to see the workspaces this token can use.'])
    )
  }
  if (status === 429) {
    const seconds = Number(context.retryAfter)
    return new RuntimeClientError(
      'cloud_rate_limited',
      reason === 'workspace_creates'
        ? 'Too many workspace creates for this account right now.'
        : 'Too many requests to Orca Cloud right now.',
      data([`Retry in ${Number.isFinite(seconds) && seconds > 0 ? seconds : 60}s.`], {
        retryAfterSeconds: Number.isFinite(seconds) ? seconds : null
      })
    )
  }
  if (status === 400) {
    return new RuntimeClientError(
      'invalid_argument',
      `Orca Cloud rejected the request: ${reason ?? code}.`,
      data([])
    )
  }
  if (status === 409) {
    return new RuntimeClientError('cloud_conflict', `Conflict: ${reason ?? code}.`, data([]))
  }
  if (status === 402 || code === 'entitlement_denied' || code === 'billing_required') {
    return new RuntimeClientError(
      'cloud_billing',
      `Orca Cloud billing refused this (${reason ?? code}).`,
      data(['Check the plan and usage limits in Orca Cloud billing settings.'])
    )
  }
  if (status === 503 && code === 'not_configured') {
    return new RuntimeClientError(
      'cloud_unavailable',
      'This Orca Cloud control plane cannot run workspaces right now (not configured).',
      data([])
    )
  }
  return new RuntimeClientError(
    status >= 500 ? 'cloud_unavailable' : 'cloud_api_error',
    `Orca Cloud returned ${status} ${code}${reason ? ` (${reason})` : ''}.`,
    data(status >= 500 ? ['Retry shortly; the workspace provider may be busy.'] : [])
  )
}
