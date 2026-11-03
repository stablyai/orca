/** Usage-provider credential bridges share one rate-limit refresher; registering them together keeps the provider set visible in one place. */
import { registerOpenCodeGoCredentialsHandlers } from './opencode-go-credentials'
import { registerMiniMaxCredentialsHandlers } from './minimax-credentials'
import { registerZcodePlanCredentialsHandlers } from './zcode-plan-credentials'
import { registerOllamaCloudCredentialsHandlers } from './ollama-cloud-credentials'
import type { RateLimitService } from '../rate-limits/service'

export function registerPlanCredentialHandlers(rateLimits: RateLimitService | null): void {
  registerOpenCodeGoCredentialsHandlers(rateLimits)
  registerMiniMaxCredentialsHandlers(rateLimits)
  registerZcodePlanCredentialsHandlers(rateLimits)
  registerOllamaCloudCredentialsHandlers(rateLimits)
}
