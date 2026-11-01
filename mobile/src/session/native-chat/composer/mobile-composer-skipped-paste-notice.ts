import { translate } from '../../../i18n/mobile-i18n'

export const MOBILE_COMPOSER_SKIPPED_PASTE_TOAST_MS = 1500

export function mobileComposerSkippedPasteNotice(count: number): string {
  return count === 1
    ? translate('chat.composer.skippedUnsupportedPaste_one', 'Skipped {{count}} unsupported file', {
        count
      })
    : translate(
        'chat.composer.skippedUnsupportedPaste_other',
        'Skipped {{count}} unsupported files',
        { count }
      )
}
