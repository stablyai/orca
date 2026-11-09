import { translate } from '../i18n/mobile-i18n'

export const nativeChatDictationCopy = {
  insertFailedCopied: () =>
    translate(
      'session.useNativeChatDictation.insertFailedCopied',
      "Couldn't insert dictation, so it was copied to the clipboard"
    ),
  insertFailed: () =>
    translate('session.useNativeChatDictation.insertFailed', "Couldn't insert dictation"),
  inserted: () => translate('session.useNativeChatDictation.inserted', 'Dictation inserted'),
  stoppedAtCloudLimit: () =>
    translate(
      'session.useNativeChatDictation.stoppedAtCloudLimit',
      'Dictation stopped at the 10-minute cloud limit.'
    ),
  stoppedAfterSilence: () =>
    translate(
      'session.useNativeChatDictation.stoppedAfterSilence',
      'Stopped after a minute of silence'
    )
}
