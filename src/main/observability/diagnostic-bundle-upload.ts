import { URL } from 'node:url'
import { MAX_BUNDLE_BYTES } from './diagnostic-bundle-limits'
import { postBodyForJson, postJsonForJson } from './diagnostic-upload-http'

const TOKEN_REQUEST_TIMEOUT_MS = 10_000
const UPLOAD_TIMEOUT_MS = 30_000

export type UploadBundleOptions = {
  readonly tokenEndpoint: string
  readonly payload: string
  readonly bundleSubmissionId: string
}

export type UploadBundleResult = {
  readonly ticketId: string
}

export type DeleteBundleOptions = {
  readonly tokenEndpoint: string
  readonly ticketId: string
}

type TokenResponse = {
  readonly token: string
  readonly expires_at: string
  readonly upload_url: string
  readonly max_bytes: number
}

type UploadResponse = {
  readonly ticket_id: string
}

export async function uploadBundle(opts: UploadBundleOptions): Promise<UploadBundleResult> {
  const bytes = Buffer.byteLength(opts.payload)
  if (bytes > MAX_BUNDLE_BYTES) {
    throw new Error(`bundle exceeds 4 MiB cap (${bytes} bytes)`)
  }

  const tokenRes = (await postJsonForJson(
    opts.tokenEndpoint,
    {
      bundle_submission_id: opts.bundleSubmissionId,
      bytes
    },
    TOKEN_REQUEST_TIMEOUT_MS
  )) as TokenResponse
  if (
    typeof tokenRes.token !== 'string' ||
    typeof tokenRes.upload_url !== 'string' ||
    typeof tokenRes.max_bytes !== 'number'
  ) {
    throw new Error('malformed token response')
  }
  if (bytes > tokenRes.max_bytes) {
    throw new Error(`bundle exceeds server-issued cap (${bytes} > ${tokenRes.max_bytes})`)
  }

  // Validate the server-chosen destination before sending the token and diagnostic payload.
  validateUploadUrl(tokenRes.upload_url, opts.tokenEndpoint)

  const uploadRes = (await postBodyForJson({
    url: tokenRes.upload_url,
    body: opts.payload,
    headers: {
      authorization: `Bearer ${tokenRes.token}`,
      'content-type': 'application/x-ndjson',
      'content-length': String(bytes)
    },
    timeoutMs: UPLOAD_TIMEOUT_MS
  })) as UploadResponse

  if (typeof uploadRes.ticket_id !== 'string' || uploadRes.ticket_id.length === 0) {
    throw new Error('malformed upload response: missing ticket_id')
  }
  return {
    ticketId: uploadRes.ticket_id
  }
}

export async function deleteBundle(opts: DeleteBundleOptions): Promise<void> {
  const endpoint = resolveDeleteEndpoint(opts.tokenEndpoint, opts.ticketId)
  await postJsonForJson(endpoint, {}, TOKEN_REQUEST_TIMEOUT_MS)
}

export function validateUploadUrl(uploadUrl: string, tokenEndpoint: string): void {
  let parsedUpload: URL
  try {
    parsedUpload = new URL(uploadUrl)
  } catch {
    throw new Error('invalid upload_url from token endpoint')
  }
  let parsedToken: URL
  try {
    parsedToken = new URL(tokenEndpoint)
  } catch {
    throw new Error('invalid tokenEndpoint configuration')
  }
  const tokenIsHttps = parsedToken.protocol === 'https:'
  if (tokenIsHttps && parsedUpload.protocol !== 'https:') {
    throw new Error('upload_url must use https when tokenEndpoint is https')
  }
  if (parsedUpload.protocol !== 'https:' && parsedUpload.protocol !== 'http:') {
    throw new Error('upload_url must use http(s)')
  }
  // HTTPS alone cannot prevent a compromised endpoint from redirecting uploads to another host.
  if (parsedUpload.host !== parsedToken.host) {
    throw new Error('upload_url host must match tokenEndpoint host')
  }
}

function resolveDeleteEndpoint(tokenEndpoint: string, ticketId: string): string {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(ticketId)) {
    throw new Error('ticketId has invalid format')
  }
  let parsedToken: URL
  try {
    parsedToken = new URL(tokenEndpoint)
  } catch {
    throw new Error('invalid tokenEndpoint configuration')
  }
  return new URL(`/diagnostics/delete/${encodeURIComponent(ticketId)}`, parsedToken).toString()
}
