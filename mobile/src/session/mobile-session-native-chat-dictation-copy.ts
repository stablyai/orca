import { translate } from '../i18n/mobile-i18n'

export const nativeChatDictationCopy = {
  insertFailedCopied: () =>
    translate(
      'session.useNativeChatDictation.insertFailedCopied',
      "Couldn't insert dictation, so it was copied to the clipboard"
    ),
  insertFailed: () =>
    translate('session.useNativeChatDictation.insertFailed', "Couldn't insert dictation"),
  inserted: () => translate('session.useNativeChatDictation.inserted', 'Dictation inserted')
}
