import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  getWslSelectionKey,
  type CodexAccountSelectionTarget
} from '../../../../shared/codex-selection-lane'
import { normalizeCodexRuntimeSelection } from '../../../codex-accounts/account-management/runtime-selection'
import { getInitialAccountRateLimitTarget } from '../../initial-account-rate-limit-target'

export function getInitialCodexRateLimitTarget(
  settings: GlobalSettings,
  platform: NodeJS.Platform = process.platform
): CodexAccountSelectionTarget {
  return getInitialAccountRateLimitTarget(
    settings,
    { getWslSelectionKey, normalizeRuntimeSelection: normalizeCodexRuntimeSelection },
    platform
  )
}
