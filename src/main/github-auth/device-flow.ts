import { getMainHttpClient } from '../network/http-client'
import type {
  GitHubDeviceFlowPollResult,
  GitHubDeviceFlowStart,
  GitHubDeviceFlowStartResult
} from '../../shared/github-account'
import { GITHUB_WEB_BASE_URL } from './github-auth-config'

// GitHub's OAuth device authorization grant — the recommended sign-in for
// desktop apps: no redirect URI, no client secret, no deep-link handler.
const DEVICE_CODE_URL = `${GITHUB_WEB_BASE_URL}/login/device/code`
const ACCESS_TOKEN_URL = `${GITHUB_WEB_BASE_URL}/login/oauth/access_token`
const DEVICE_FLOW_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
// `repo` covers private repository listing and HTTPS clone; `read:user` renders
// the signed-in account header.
const DEVICE_FLOW_SCOPE = 'repo read:user'

async function postForm(
  url: string,
  body: Record<string, string>,
  timeoutMs = 15000
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await getMainHttpClient().fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(body).toString()
    })
    if (!response.ok) {
      return { ok: false, error: `GitHub responded with ${response.status}` }
    }
    return { ok: true, data: (await response.json()) as Record<string, unknown> }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export async function startGitHubDeviceFlow(
  clientId: string
): Promise<GitHubDeviceFlowStartResult> {
  const result = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope: DEVICE_FLOW_SCOPE })
  if (!result.ok) {
    return { ok: false, error: `Could not reach GitHub. ${result.error}` }
  }
  const deviceCode = asString(result.data.device_code)
  const userCode = asString(result.data.user_code)
  const verificationUri = asString(result.data.verification_uri)
  if (!deviceCode || !userCode || !verificationUri) {
    return { ok: false, error: 'GitHub returned an incomplete device flow response.' }
  }
  const flow: GitHubDeviceFlowStart = {
    deviceCode,
    userCode,
    verificationUri,
    expiresInSeconds: asPositiveNumber(result.data.expires_in) ?? 900,
    pollIntervalSeconds: asPositiveNumber(result.data.interval) ?? 5
  }
  return { ok: true, flow }
}

export type GitHubDeviceFlowTokenPoll =
  | { status: 'pending'; pollIntervalSeconds?: number }
  | { status: 'authorized'; token: string }
  | { status: 'error'; error: string }

// Maps the RFC 8628 error vocabulary onto UI states; `slow_down` additionally
// carries GitHub's requested interval so the poller can back off.
export function pollResultFromTokenPayload(
  payload: Record<string, unknown>
): GitHubDeviceFlowTokenPoll {
  const token = asString(payload.access_token)
  if (token) {
    return { status: 'authorized', token }
  }
  switch (asString(payload.error)) {
    case 'authorization_pending':
      return { status: 'pending' }
    case 'slow_down': {
      const interval = asPositiveNumber(payload.interval)
      return interval === null
        ? { status: 'pending' }
        : { status: 'pending', pollIntervalSeconds: interval }
    }
    case 'access_denied':
      return { status: 'error', error: 'Sign-in was declined on GitHub.' }
    case 'expired_token':
      return { status: 'error', error: 'The sign-in code expired. Start over to get a new one.' }
    case 'incorrect_device_code':
      return { status: 'error', error: 'The sign-in session is no longer valid. Start over.' }
    case null:
    default:
      return {
        status: 'error',
        error: asString(payload.error_description) ?? 'GitHub sign-in failed. Try again.'
      }
  }
}

export async function pollGitHubDeviceFlow(
  clientId: string,
  deviceCode: string
): Promise<GitHubDeviceFlowTokenPoll> {
  const result = await postForm(ACCESS_TOKEN_URL, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: DEVICE_FLOW_GRANT
  })
  if (!result.ok) {
    return { status: 'error', error: `Could not reach GitHub. ${result.error}` }
  }
  return pollResultFromTokenPayload(result.data)
}

export type { GitHubDeviceFlowPollResult }
