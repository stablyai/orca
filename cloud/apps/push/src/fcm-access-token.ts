import { GoogleAuth } from 'google-auth-library'
import { FCM_SCOPE } from './fcm-client.js'

// GoogleAuth handles metadata credentials on Cloud Run and GOOGLE_APPLICATION_CREDENTIALS locally, including cache/refresh.
export function createFcmAccessTokenProvider(): () => Promise<string> {
  const auth = new GoogleAuth({ scopes: [FCM_SCOPE] })
  return async () => {
    const client = await auth.getClient()
    const token = await client.getAccessToken()
    if (!token.token) throw new Error('fcm_access_token_unavailable')
    return token.token
  }
}
