import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RateLimitService } from '../rate-limits/service'

export type ClaudeUsagePollingSettings = Partial<Pick<GlobalSettings, 'claudeAutoSwitchEnabled'>>

export const CLAUDE_USAGE_POLLING_SETTING_KEYS = ['claudeAutoSwitchEnabled'] as const

type UsagePollingRateLimits = {
  addUsageViewer: RateLimitService['addUsageViewer']
  refreshIfStale: () => Promise<unknown>
}

/** Why: auto-switch decides on readings; without polling a headless host never has one to decide on. */
export function shouldPollClaudeUsage(settings: ClaudeUsagePollingSettings): boolean {
  return settings.claudeAutoSwitchEnabled === true
}

/** Holds a usage viewer while auto-switch is on and releases it when auto-switch is off; idempotent. */
export function createClaudeUsagePollingSwitch(
  rateLimits: UsagePollingRateLimits,
  getSettings: () => ClaudeUsagePollingSettings
): { apply: (updates?: object) => boolean; polling: () => boolean } {
  let release: (() => void) | null = null
  return {
    polling: () => release !== null,
    apply: (updates) => {
      if (updates && !CLAUDE_USAGE_POLLING_SETTING_KEYS.some((key) => key in updates)) {
        return release !== null
      }
      const wanted = shouldPollClaudeUsage(getSettings())
      if (wanted && !release) {
        // The switch counts as a watcher, like a paired client's stream, so polls run with no window.
        release = rateLimits.addUsageViewer()
        void rateLimits.refreshIfStale()
      } else if (!wanted && release) {
        release()
        release = null
      }
      return release !== null
    }
  }
}
