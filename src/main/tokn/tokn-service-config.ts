import { app } from 'electron'
import { cleanCloudServiceOrigin } from '../../shared/cloud-service-url'
import type { LoopbackPkceFlowConfig } from '../oauth-loopback/loopback-pkce-flow'

const PRODUCTION_ORIGIN = 'https://toknhq.com'

/** Registered with tokn as a public native client (RFC 8252): PKCE, no secret. */
export const TOKN_CLIENT_ID = 'orca'
const TOKN_CALLBACK_PATH = '/tokn/callback'

export function toknSignInFlowConfig(origin: string): LoopbackPkceFlowConfig {
  return {
    callbackPath: TOKN_CALLBACK_PATH,
    errorPrefix: 'tokn_auth',
    browserCopy: {
      success: 'Orca is connected to tokn',
      invalid: 'Invalid tokn sign-in response.',
      cancelled: 'Connecting Orca to tokn was cancelled.',
      failed: 'Connecting Orca to tokn failed. Return to Orca and try again.'
    },
    buildAuthorizeUrl: ({ redirectUri, state, codeChallenge }) => {
      const url = new URL('/oauth/authorize', origin)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', TOKN_CLIENT_ID)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('scope', 'profile usage:write')
      url.searchParams.set('state', state)
      url.searchParams.set('code_challenge', codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      return url.toString()
    }
  }
}

function isPackagedOrcaBuild(): boolean {
  try {
    return app?.isPackaged === true
  } catch {
    return false
  }
}

// Only development builds may point at another tokn, so a packaged app never sends its token elsewhere.
export function getToknOrigin(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = isPackagedOrcaBuild()
): string {
  if (packaged) {
    return PRODUCTION_ORIGIN
  }
  return cleanCloudServiceOrigin(env.ORCA_TOKN_URL, true) ?? PRODUCTION_ORIGIN
}

/** Links shown in the UI must stay on tokn; anything else from the server is dropped. */
export function toknOwnedUrl(value: unknown, origin: string): string | null {
  if (typeof value !== 'string') {
    return null
  }
  try {
    const url = new URL(value)
    return url.origin === origin ? url.toString() : null
  } catch {
    return null
  }
}
