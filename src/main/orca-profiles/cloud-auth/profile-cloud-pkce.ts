import { randomBytes } from 'node:crypto'
import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import {
  base64Url,
  beginLoopbackPkceFlow,
  type LoopbackAuthorizationCode,
  type LoopbackPkceFlowOptions
} from '../../oauth-loopback/loopback-pkce-flow'

export type OrcaCloudAuthorizationCode = LoopbackAuthorizationCode & {
  nonce: string
}

export async function beginOrcaCloudPkceFlow(
  config: OrcaCloudAuthConfig,
  localProfileId: string,
  options: LoopbackPkceFlowOptions = {}
): Promise<OrcaCloudAuthorizationCode> {
  const nonce = base64Url(randomBytes(32))
  const code = await beginLoopbackPkceFlow(
    {
      callbackPath: '/auth/callback',
      errorPrefix: 'orca_cloud_auth',
      browserCopy: {
        success: 'Signed in to Orca',
        invalid: 'Invalid Orca sign-in response.',
        cancelled: 'Orca sign-in was cancelled.',
        failed: 'Orca sign-in failed. Return to Orca and try again.'
      },
      buildAuthorizeUrl: ({ redirectUri, state, codeChallenge }) => {
        const authorizeUrl = new URL(config.authorizeEndpoint)
        authorizeUrl.searchParams.set('client_id', config.clientId)
        authorizeUrl.searchParams.set('response_type', 'code')
        authorizeUrl.searchParams.set('redirect_uri', redirectUri)
        authorizeUrl.searchParams.set('scope', config.scope)
        authorizeUrl.searchParams.set('nonce', nonce)
        authorizeUrl.searchParams.set('state', state)
        authorizeUrl.searchParams.set('code_challenge', codeChallenge)
        authorizeUrl.searchParams.set('code_challenge_method', 'S256')
        authorizeUrl.searchParams.set('local_profile_id', localProfileId)
        return authorizeUrl.toString()
      }
    },
    options
  )
  return { ...code, nonce }
}
