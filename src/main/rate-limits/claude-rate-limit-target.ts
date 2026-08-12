import type { GlobalSettings } from '../../shared/types'
import {
  getClaudeWslSelectionKey,
  normalizeClaudeRuntimeSelection,
  type ClaudeAccountSelectionTarget
} from '../claude-accounts/runtime-selection'
import { getInitialAccountRateLimitTarget } from './initial-account-rate-limit-target'

export function getInitialClaudeRateLimitTarget(
  settings: GlobalSettings,
  platform: NodeJS.Platform = process.platform
): ClaudeAccountSelectionTarget {
  return getInitialAccountRateLimitTarget(
    settings,
    {
      getWslSelectionKey: getClaudeWslSelectionKey,
      normalizeRuntimeSelection: normalizeClaudeRuntimeSelection
    },
    platform
  )
}
