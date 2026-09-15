import { readFetchResponseTextWithinLimit } from '../../shared/fetch-response-body'

const GITEA_AUTH_ERROR_MAX_LEN = 280
const GITEA_AUTH_ERROR_MAX_BODY_BYTES = 4 * 1024

/** Keep server auth text, but never echo the configured token or query secrets. */
export function sanitizeGiteaAuthError(raw: string, token: string | null): string | null {
  let text = raw.replace(/\s+/g, ' ').trim()
  if (!text) {
    return null
  }
  if (token) {
    text = text.split(token).join('[REDACTED]')
  }
  text = text
    .replace(/([?&](?:access_token|token|key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*[:=]\s*(?:token|bearer)\s+)[^\s]+/gi, '$1[REDACTED]')
  if (text.length > GITEA_AUTH_ERROR_MAX_LEN) {
    text = `${text.slice(0, GITEA_AUTH_ERROR_MAX_LEN - 3)}...`
  }
  return text
}

async function readGiteaErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = await readFetchResponseTextWithinLimit(response, GITEA_AUTH_ERROR_MAX_BODY_BYTES)
    const trimmed = body.trim()
    if (!trimmed) {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') {
        const errorBody = parsed as { message?: unknown; error?: unknown }
        for (const candidate of [errorBody.message, errorBody.error]) {
          if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim()
          }
        }
      }
    } catch {
      return trimmed
    }
  } catch {
    // Body already consumed or stream failed — fall through.
  }
  return null
}

export type GiteaUserProbe = {
  login?: string | null
  username?: string | null
  full_name?: string | null
}

/** Probe `/user` and keep the server error body on non-2xx (requestJson collapses it). */
export async function probeGiteaAuthenticatedUser(
  baseUrl: string,
  token: string
): Promise<{ user: GiteaUserProbe | null; authError: string | null }> {
  try {
    const response = await fetch(new URL(`${baseUrl.replace(/\/+$/, '')}/user`), {
      headers: {
        Accept: 'application/json',
        Authorization: `token ${token}`
      },
      signal: AbortSignal.timeout(4000)
    })
    if (!response.ok) {
      const raw = (await readGiteaErrorMessage(response)) ?? `HTTP ${response.status}`
      return { user: null, authError: sanitizeGiteaAuthError(raw, token) }
    }
    return { user: (await response.json()) as GiteaUserProbe, authError: null }
  } catch {
    return { user: null, authError: null }
  }
}
