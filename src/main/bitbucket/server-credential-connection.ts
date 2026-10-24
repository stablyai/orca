import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import {
  getBitbucketServerBaseUrl,
  hasEnvBitbucketServerCredential,
  normalizeBitbucketServerBaseUrl,
  serverAuthHeaders
} from './server-auth-config'
import {
  clearStoredBitbucketServerCredential,
  getBitbucketServerCredentialProtection,
  getStoredBitbucketServerMetadata,
  hasStoredBitbucketServerCredential,
  saveBitbucketServerCredential
} from './server-credential-store'
import type {
  BitbucketServerConnectArgs,
  BitbucketServerConnectionStatus,
  BitbucketServerConnectResult
} from '../../shared/bitbucket-server-credentials'

const VERIFY_TIMEOUT_MS = 6000

type VerifyResult = { ok: true; account: string | null } | { ok: false; rejected: boolean }

// Why: /plugins/servlet/applinks/whoami answers 200 with an empty body for a bad token,
// so only an authenticated REST call proves the credential.
async function verifyToken(baseUrl: string, accessToken: string): Promise<VerifyResult> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}/rest/api/1.0/users?limit=1`, {
      headers: { Accept: 'application/json', ...serverAuthHeaders({ baseUrl, accessToken }) },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
    })
  } catch {
    return { ok: false, rejected: false }
  }
  await cancelUnreadResponseBody(response)
  if (!response.ok) {
    return { ok: false, rejected: response.status === 401 || response.status === 403 }
  }
  return { ok: true, account: response.headers.get('X-AUSERNAME') }
}

export async function connectBitbucketServer(
  input: BitbucketServerConnectArgs
): Promise<BitbucketServerConnectResult> {
  const baseUrl = normalizeBitbucketServerBaseUrl(input.baseUrl)
  const accessToken = input.accessToken.trim()
  if (!baseUrl || !accessToken) {
    return { ok: false, error: 'Enter the server URL and an access token.' }
  }
  const result = await verifyToken(baseUrl, accessToken)
  if (!result.ok) {
    return {
      ok: false,
      error: result.rejected
        ? 'Bitbucket Server rejected this token. Check the token, then try again.'
        : 'Could not reach Bitbucket Server. Check the server URL and your connection, then try again.'
    }
  }
  saveBitbucketServerCredential({ baseUrl, account: result.account, accessToken })
  return { ok: true, account: result.account }
}

export function disconnectBitbucketServer(): void {
  clearStoredBitbucketServerCredential()
}

export function getBitbucketServerConnectionStatus(): BitbucketServerConnectionStatus {
  if (hasEnvBitbucketServerCredential()) {
    return {
      configured: true,
      source: 'environment',
      credentialProtection: null,
      account: null,
      baseUrl: getBitbucketServerBaseUrl()
    }
  }
  if (hasStoredBitbucketServerCredential()) {
    const metadata = getStoredBitbucketServerMetadata()
    return {
      configured: true,
      source: 'stored',
      credentialProtection: getBitbucketServerCredentialProtection(),
      account: metadata?.account ?? null,
      baseUrl: metadata?.baseUrl ?? null
    }
  }
  return {
    configured: false,
    source: 'none',
    credentialProtection: null,
    account: null,
    baseUrl: null
  }
}
