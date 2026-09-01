import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'
import { withSpan } from '../observability/tracer'
import type { OdooInstance } from '../../shared/odoo-types'
const MAX_CONCURRENT = 4
let running = 0
const queue: (() => void)[] = []

export function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    queue.push(() => {
      running += 1
      resolve()
    })
  )
}

export function release(): void {
  running -= 1
  const next = queue.shift()
  if (next) {
    next()
  }
}

export type OdooClientForInstance = {
  instance: OdooInstance
  apiKey: string
}

export class OdooApiError extends Error {
  /** Odoo exception class name, e.g. `odoo.exceptions.AccessDenied`. */
  exceptionName: string | null
  status: number | null

  constructor(message: string, exceptionName: string | null = null, status: number | null = null) {
    super(message)
    this.name = 'OdooApiError'
    this.exceptionName = exceptionName
    this.status = status
  }
}

export function isAuthError(error: unknown): boolean {
  // Why: Odoo raises AccessError for record-level permission gaps even when the
  // credential is valid, so only AccessDenied means the API key itself failed.
  return error instanceof OdooApiError && error.exceptionName === 'odoo.exceptions.AccessDenied'
}

function describeErrorCause(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('cause' in error)) {
    return undefined
  }
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`
  }
  return cause === undefined ? undefined : String(cause)
}

async function odooFetch(url: string, init: RequestInit): Promise<Response> {
  return withSpan(
    'odoo.request',
    async (span) => {
      span.setAttribute('odoo.serverUrl', new URL(url).origin)
      const httpClient = getMainHttpClient()
      const proxySession = httpClient.proxySession()
      await ensureElectronProxyFromEnvironment({
        ...(proxySession ? { proxySession } : {}),
        probeUrl: url
      }).catch((error) => {
        span.addEvent('odoo.proxySetupFailed', {
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error)
        })
      })
      try {
        // Why the port: on the desktop this is Electron's net.fetch, which follows
        // Chromium proxy/session state and avoids undici's stale keep-alive sockets
        // after VPN path changes. A host without Chromium gets Node's fetch instead.
        return await httpClient.fetch(url, init)
      } catch (error) {
        span.setAttribute(
          'odoo.transportErrorName',
          error instanceof Error ? error.name : typeof error
        )
        span.setAttribute(
          'odoo.transportErrorMessage',
          error instanceof Error ? error.message : String(error)
        )
        const cause = describeErrorCause(error)
        if (cause) {
          span.setAttribute('odoo.transportErrorCause', cause)
        }
        throw error
      }
    },
    { kind: 'client' }
  )
}

type OdooJsonRpcEnvelope = {
  result?: unknown
  error?: {
    message?: string
    data?: {
      name?: string
      message?: string
      arguments?: unknown[]
    }
  }
}

function readOdooRpcError(envelope: OdooJsonRpcEnvelope, status: number | null): OdooApiError {
  const data = envelope.error?.data
  // Odoo nests the useful text in error.data.message; error.message is the
  // generic "Odoo Server Error" banner.
  const message =
    (typeof data?.message === 'string' && data.message.trim()) ||
    (typeof envelope.error?.message === 'string' && envelope.error.message.trim()) ||
    'Odoo request failed.'
  return new OdooApiError(message, typeof data?.name === 'string' ? data.name : null, status)
}

/**
 * Posts a JSON-RPC call to `/jsonrpc`.
 *
 * Why: Odoo answers RPC faults with HTTP 200 and an `error` member, so the
 * envelope — not the status code — decides success.
 */
export async function odooJsonRpc(
  serverUrl: string,
  service: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  const response = await odooFetch(`${serverUrl}/jsonrpc`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service, method, args },
      id: Date.now()
    })
  })

  if (!response.ok) {
    throw new OdooApiError(
      response.statusText || `Odoo request failed (${response.status})`,
      null,
      response.status
    )
  }

  let envelope: OdooJsonRpcEnvelope
  try {
    envelope = (await response.json()) as OdooJsonRpcEnvelope
  } catch {
    // A JSON-RPC endpoint that answers with non-JSON is almost always a proxy
    // or a wrong base URL rather than Odoo itself.
    throw new OdooApiError('Odoo returned a malformed response. Check the server URL.', null, null)
  }

  if (envelope.error) {
    throw readOdooRpcError(envelope, response.status)
  }
  return envelope.result
}

export async function authenticate(
  serverUrl: string,
  database: string,
  login: string,
  apiKey: string
): Promise<number> {
  const result = await odooJsonRpc(serverUrl, 'common', 'authenticate', [
    database,
    login,
    apiKey,
    {}
  ])
  // Odoo returns `false` (not an error) when credentials are rejected.
  if (typeof result !== 'number') {
    throw new OdooApiError(
      'Odoo rejected the credentials. Check the database, login, and API key.',
      'odoo.exceptions.AccessDenied',
      null
    )
  }
  return result
}

/** Calls a model method through `object.execute_kw` on the instance. */
export async function executeKw<T>(
  client: OdooClientForInstance,
  model: string,
  method: string,
  args: unknown[] = [],
  kwargs: Record<string, unknown> = {}
): Promise<T> {
  const result = await odooJsonRpc(client.instance.serverUrl, 'object', 'execute_kw', [
    client.instance.database,
    client.instance.uid,
    client.apiKey,
    model,
    method,
    args,
    kwargs
  ])
  return result as T
}
