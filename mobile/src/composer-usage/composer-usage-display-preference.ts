import {
  normalizeUsagePercentageDisplay,
  type UsagePercentageDisplay
} from '../../../src/shared/agent-usage/display/usage-percentage-display'
import { createComposerUsageChoiceStore } from './composer-usage-choice-store'

export const COMPOSER_USAGE_DISPLAY_KEY = 'orca:composerUsageDisplay'

const store = createComposerUsageChoiceStore<UsagePercentageDisplay>(
  COMPOSER_USAGE_DISPLAY_KEY,
  normalizeUsagePercentageDisplay,
  'Composer usage display'
)

export const setComposerUsageDisplay = store.set

/** Whether every composer meter on this device shows used (default) or remaining. */
export const useComposerUsageDisplay = store.use
