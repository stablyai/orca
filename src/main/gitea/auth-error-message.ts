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

function extractGiteaParsedErrorCandidate(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  if ('message' in parsed && typeof parsed.message === 'string' && parsed.message.trim()) {
    return parsed.message.trim()
  }
  if ('error' in parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
    return parsed.error.trim()
  }
  return null
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
      const candidate = extractGiteaParsedErrorCandidate(parsed)
      if (candidate) {
        return candidate
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

function parseGiteaUserProbe(data: unknown): GiteaUserProbe | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const probe: GiteaUserProbe = {}
  if ('login' in data && (typeof data.login === 'string' || data.login === null)) {
    probe.login = data.login
  }
  if ('username' in data && (typeof data.username === 'string' || data.username === null)) {
    probe.username = data.username
  }
  if ('full_name' in data && (typeof data.full_name === 'string' || data.full_name === null)) {
    probe.full_name = data.full_name
  }
  return probe
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
    const data: unknown = await response.json()
    return { user: parseGiteaUserProbe(data), authError: null }
  } catch {
    return { user: null, authError: null }
  }
}
