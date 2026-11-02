import type { Translate } from '../i18n/mobile-i18n'
import type { SendSheetState } from '../session/mobile-diff-review-screen-model'
import type { useMobileDiffReviewController } from '../session/use-mobile-diff-review-controller'

export function sendSheetMessage(
  t: Translate,
  controller: ReturnType<typeof useMobileDiffReviewController>,
  load: SendSheetState
): string | undefined {
  const count = controller.unsentComments.length
  return load.kind === 'loading'
    ? t('components.diffReviewDrawers.loadingSessions', 'Loading agent sessions...')
    : load.kind === 'error'
      ? load.message
      : count === 1
        ? t('components.diffReviewDrawers.unsentNotes_one', '{{count}} unsent notes', { count })
        : t('components.diffReviewDrawers.unsentNotes_other', '{{count}} unsent notes', { count })
}
