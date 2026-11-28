import type { ComposerUsageWindowChoice } from './agent-usage-provider'
import { createComposerUsageChoiceStore } from './composer-usage-choice-store'

export const COMPOSER_USAGE_WINDOW_KEY = 'orca:composerUsageWindow'

const store = createComposerUsageChoiceStore<ComposerUsageWindowChoice>(
  COMPOSER_USAGE_WINDOW_KEY,
  (raw) => (raw === 'weekly' ? 'weekly' : 'session'),
  'Composer usage window'
)

export const setComposerUsageWindow = store.set

/** Which window the composer meter shows on this device: the 5-hour session (default) or weekly. */
export const useComposerUsageWindow = store.use
