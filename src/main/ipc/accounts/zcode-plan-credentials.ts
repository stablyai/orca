import { registerAppHandler } from '../app-registry/app-handler-registry'

import {
  clearZcodePlanApiKeyCredential,
  getZcodePlanCredentialsStatus,
  saveZcodePlanApiKeyCredential
} from '../../zcode/zcode-plan-credential-commands'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'

export function registerZcodePlanCredentialsHandlers(rateLimits: RateLimitService | null): void {
  registerAppHandler('zcodePlanCredentials:getStatus', () => getZcodePlanCredentialsStatus())
  registerAppHandler('zcodePlanCredentials:saveApiKey', (_event, key: unknown) =>
    saveZcodePlanApiKeyCredential(rateLimits, key)
  )
  registerAppHandler('zcodePlanCredentials:clearApiKey', () =>
    clearZcodePlanApiKeyCredential(rateLimits)
  )
}
