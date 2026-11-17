// Transport helpers for the environment client: bounded JSON reads and error mapping.
import { HostedEnvironmentErrorResponseSchema } from '../../../shared/hosted-sandbox/hosted-environment-wire'
import { EnvironmentProviderError } from '../../environment-providers/environment-provider-driver'

// A detail view carries 30 builds plus a 20k-char script; list carries every environment.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/** `code` is the control plane's error (`forbidden`, `conflict`, ...) or a transport one. */
export class HostedEnvironmentRequestError extends Error {
  constructor(
    readonly code: string,
    readonly reason: string | null,
    message: string,
    readonly status: number | null = null
  ) {
    super(message)
    this.name = 'HostedEnvironmentRequestError'
  }
}

/** A desktop-side refusal whose message is already written for the user (or the agent). */
export class HostedEnvironmentUserError extends HostedEnvironmentRequestError {}

export function parseBaseUrl(value: string): URL {
  const url = new URL(value.endsWith('/') ? value : `${value}/`)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Orca Cloud control plane must be HTTPS.')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Orca Cloud control plane URL must not carry credentials, query or fragment.')
  }
  return url
}

/** Reads at most MAX_RESPONSE_BYTES; a larger body reads as unparseable instead of buffering it all. */
export async function readJson(response: Response): Promise<unknown> {
  if (!response.body) {
    return null
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

export function errorFromResponse(status: number, payload: unknown): HostedEnvironmentRequestError {
  const parsed = HostedEnvironmentErrorResponseSchema.safeParse(payload)
  if (parsed.success) {
    return new HostedEnvironmentRequestError(
      parsed.data.error,
      parsed.data.reason ?? null,
      `Orca Cloud refused the request (${parsed.data.error}${parsed.data.reason ? `: ${parsed.data.reason}` : ''}).`,
      status
    )
  }
  if (status >= 300 && status < 400) {
    return new HostedEnvironmentRequestError(
      'invalid_response',
      null,
      'Orca Cloud answered with a redirect.',
      status
    )
  }
  return new HostedEnvironmentRequestError(
    status === 401
      ? 'unauthorized'
      : status === 403
        ? 'forbidden'
        : status === 404
          ? 'not_found'
          : 'unavailable',
    null,
    `Orca Cloud request failed (HTTP ${status}).`,
    status
  )
}

export function transportError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal | undefined
): HostedEnvironmentRequestError {
  if (error instanceof HostedEnvironmentRequestError) {
    return error
  }
  // Token minting reports sign-in problems as provider errors.
  if (error instanceof EnvironmentProviderError) {
    return new HostedEnvironmentRequestError(error.code, error.reason ?? null, error.message)
  }
  if (callerSignal?.aborted) {
    return new HostedEnvironmentRequestError('aborted', null, 'Orca Cloud request was cancelled.')
  }
  if (timeoutSignal?.aborted) {
    return new HostedEnvironmentRequestError('timeout', null, 'Orca Cloud did not answer in time.')
  }
  return new HostedEnvironmentRequestError('unavailable', null, 'Could not reach Orca Cloud.')
}
