import type { UsageRateLimitSource } from '../../shared/rate-limit-types'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

export type ClaudeUsageRefreshStep = {
  source: UsageRateLimitSource
  reason: 'app-auto-preferred-oauth' | 'app-auto-fallback-cli' | 'future-web-fallback-deferred'
}

export type ClaudeUsageRefreshPlanInput = {
  authPreparation?: ClaudeRuntimeAuthPreparation
  allowCliFallback: boolean
}

export type ClaudeUsageRefreshPlan = {
  steps: ClaudeUsageRefreshStep[]
  webDeferred: boolean
}

export function resolveClaudeUsageRefreshPlan(
  input: ClaudeUsageRefreshPlanInput
): ClaudeUsageRefreshPlan {
  const steps: ClaudeUsageRefreshStep[] = [
    {
      source: 'oauth',
      reason: 'app-auto-preferred-oauth'
    }
  ]

  if (input.allowCliFallback && isCliPlausiblyAvailable(input.authPreparation)) {
    steps.push({
      source: 'cli',
      reason: 'app-auto-fallback-cli'
    })
  }

  return {
    steps,
    webDeferred: true
  }
}

function isCliPlausiblyAvailable(authPreparation?: ClaudeRuntimeAuthPreparation): boolean {
  if (authPreparation?.runtime === 'wsl') {
    return Boolean(authPreparation.wslDistro && authPreparation.wslLinuxConfigDir)
  }
  return true
}
