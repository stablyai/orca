// Whether Google still knows this computer's app key, without signing anyone in: a code exchange
// with a made-up code fails as invalid_grant for a live key, and invalid_client for one that was
// deleted or never existed.
import type { GoogleClientConfig } from '../../shared/google/google-client-config'
import type { GoogleClientKeyState } from '../../shared/google/google-connect-types'
import { GOOGLE_TOKEN_URL, type GoogleHttp } from './google-token-endpoint'

const CHECK_TIMEOUT_MS = 10_000
// Google names a removed client invalid_client here; its sign-in pages also say deleted or disabled.
const GONE: ReadonlySet<string> = new Set(['invalid_client', 'deleted_client', 'disabled_client'])

export async function checkGoogleClientKey(
  http: GoogleHttp,
  client: Pick<GoogleClientConfig, 'clientId' | 'clientSecret'>,
  signal?: AbortSignal
): Promise<GoogleClientKeyState> {
  try {
    const response = await http(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'orca-key-check',
        redirect_uri: 'http://127.0.0.1',
        client_id: client.clientId,
        client_secret: client.clientSecret
      }).toString(),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)])
        : AbortSignal.timeout(CHECK_TIMEOUT_MS)
    })
    const body: unknown = await response.json().catch(() => null)
    const error =
      typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined
    return error === 'invalid_grant'
      ? 'works'
      : error && GONE.has(String(error))
        ? 'gone'
        : 'unknown'
  } catch {
    return 'unknown'
  }
}
