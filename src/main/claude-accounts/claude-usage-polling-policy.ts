import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RateLimitService } from '../rate-limits/service'

export type ClaudeUsagePollingSettings = Partial<Pick<GlobalSettings, 'claudeAutoSwitchEnabled'>>

export const CLAUDE_USAGE_POLLING_SETTING_KEYS = ['claudeAutoSwitchEnabled'] as const

/** Why: auto-switch decides on readings; without polling a headless host never has one to decide on. */
export function shouldPollClaudeUsage(settings: ClaudeUsagePollingSettings): boolean {
  return settings.claudeAutoSwitchEnabled === true
}

/** Starts polling when auto-switch needs it and stops it when auto-switch is off; idempotent. */
export function createClaudeUsagePollingSwitch(
  rateLimits: Pick<RateLimitService, 'start' | 'stop'>,
  getSettings: () => ClaudeUsagePollingSettings
): { apply: (updates?: object) => boolean; polling: () => boolean } {
  let polling = false
  return {
    polling: () => polling,
    apply: (updates) => {
      if (updates && !CLAUDE_USAGE_POLLING_SETTING_KEYS.some((key) => key in updates)) {
        return polling
      }
      const wanted = shouldPollClaudeUsage(getSettings())
      if (wanted && !polling) {
        rateLimits.start({ fetchImmediately: true, pollWithoutWindow: true })
        polling = true
      } else if (!wanted && polling) {
        rateLimits.stop()
        polling = false
      }
      return polling
    }
  }
}
