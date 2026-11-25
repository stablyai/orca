import { translate } from '../i18n/mobile-i18n'

// Words for a dictation whose target is off screen: the pill and the toast that offers a way back.
export const dictationAwayCopy = {
  insertedIn: ({ title, target }: { title: string; target: { field: string } | null }) =>
    target?.field === 'live'
      ? translate('dictation.announce.typedInto', 'Typed into {{target}}', { target: title })
      : translate('dictation.announce.insertedIn', 'Inserted in {{target}}', { target: title }),
  open: () => translate('dictation.pill.open', 'Open'),
  listening: () => translate('dictation.pill.listening', 'Listening'),
  starting: () => translate('dictation.pill.starting', 'Starting'),
  finishing: () => translate('dictation.pill.finishing', 'Finishing'),
  stopped: () => translate('dictation.pill.stopped', 'Dictation stopped'),
  label: (target: string, duration: string) =>
    translate('dictation.pill.label', 'Dictation to {{target}}, {{duration}}', {
      target,
      duration
    }),
  hint: () => translate('dictation.pill.hint', 'Double-tap to go back')
}
