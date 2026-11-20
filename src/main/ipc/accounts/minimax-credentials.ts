import { registerAppHandler } from '../app-registry/app-handler-registry'

import {
  clearMiniMaxApiKeyCredential,
  clearMiniMaxSessionCookieCredential,
  getMiniMaxCredentialsStatus,
  saveMiniMaxApiKeyCredential,
  saveMiniMaxSessionCookieCredential
} from '../../minimax/minimax-credential-commands'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'

export function registerMiniMaxCredentialsHandlers(rateLimits: RateLimitService | null): void {
  registerAppHandler('minimaxCredentials:getStatus', () => getMiniMaxCredentialsStatus())
  registerAppHandler('minimaxCredentials:saveCookie', (_event, cookie: unknown) =>
    saveMiniMaxSessionCookieCredential(rateLimits, cookie)
  )
  registerAppHandler('minimaxCredentials:clearCookie', () =>
    clearMiniMaxSessionCookieCredential(rateLimits)
  )
  registerAppHandler('minimaxCredentials:saveApiKey', (_event, key: unknown) =>
    saveMiniMaxApiKeyCredential(rateLimits, key)
  )
  registerAppHandler('minimaxCredentials:clearApiKey', () =>
    clearMiniMaxApiKeyCredential(rateLimits)
  )
}
