import { translate } from '../i18n/mobile-i18n'
import { dictationSpokenDuration } from './mobile-dictation-controls-copy'

// What a screen reader hears as a dictation moves along; nothing while you talk, so it never talks over you.
export const dictationAnnounceCopy = {
  listening: (engine: 'phone' | 'computer', computer: string | null) =>
    engine === 'phone'
      ? translate('dictation.announce.listeningOnPhone', 'Listening. Transcribing on this phone.')
      : computer
        ? translate('dictation.announce.listeningOn', 'Listening. Transcribing on {{computer}}.', {
            computer
          })
        : translate(
            'dictation.announce.listeningOnComputer',
            'Listening. Transcribing on the computer.'
          ),
  stillListening: () => translate('dictation.announce.stillListening', 'Still listening.'),
  finishing: () => translate('dictation.announce.finishing', 'Finishing.'),
  // Once, with the whole delay: the countdown's ticking seconds stay silent.
  inserted: (sendingInMs?: number) =>
    sendingInMs === undefined
      ? translate('dictation.announce.inserted', 'Inserted.')
      : translate('dictation.announce.insertedSending', 'Inserted. Sending in {{duration}}.', {
          duration: dictationSpokenDuration(Math.ceil(sendingInMs / 1000))
        }),
  cancelled: () => translate('dictation.announce.cancelled', 'Dictation cancelled.'),
  movedToComputer: (computer: string | null) =>
    computer
      ? translate(
          'dictation.announce.movedTo',
          'This phone stopped transcribing. Continuing on {{computer}}.',
          { computer }
        )
      : translate(
          'dictation.announce.movedToComputer',
          'This phone stopped transcribing. Continuing on the computer.'
        ),
  stoppedKept: (reason: string | null) =>
    reason
      ? translate(
          'dictation.announce.stoppedKept',
          'Dictation stopped. {{reason}}. Your recording is kept.',
          { reason }
        )
      : translate(
          'dictation.announce.stoppedKeptGeneric',
          'Dictation stopped. Your recording is kept.'
        )
}
