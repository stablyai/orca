import { GoogleAuth } from 'google-auth-library'
import { FCM_SCOPE } from './fcm-client.js'

// Resolves the runtime service account credential from the GCE metadata server
// in Cloud Run and from GOOGLE_APPLICATION_CREDENTIALS locally; the library
// caches and refreshes the token itself.
export function createFcmAccessTokenProvider(): () => Promise<string> {
  const auth = new GoogleAuth({ scopes: [FCM_SCOPE] })
  return async () => {
    const client = await auth.getClient()
    const token = await client.getAccessToken()
    if (!token.token) throw new Error('fcm_access_token_unavailable')
    return token.token
  }
}
