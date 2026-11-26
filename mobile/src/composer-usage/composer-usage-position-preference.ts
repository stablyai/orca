import { createComposerUsageChoiceStore } from './composer-usage-choice-store'

export const COMPOSER_USAGE_POSITION_KEY = 'orca:composerUsagePosition'

/** `row`: a compact meter in the composer's controls row. `above`: a full-width strip over the text. */
export type ComposerUsagePosition = 'row' | 'above'

const store = createComposerUsageChoiceStore<ComposerUsagePosition>(
  COMPOSER_USAGE_POSITION_KEY,
  (raw) => (raw === 'above' ? 'above' : 'row'),
  'Composer usage position'
)

export const setComposerUsagePosition = store.set

/** Where the chat composer shows its usage meter on this device. */
export const useComposerUsagePosition = store.use
