import type { Translate } from '../i18n/mobile-i18n'

// Words for a dictation whose target is off screen: the pill and the toast that offers a way back.
export const dictationAwayCopy = {
  insertedIn: (
    { title, target }: { title: string; target: { field: string } | null },
    t: Translate
  ) =>
    target?.field === 'live'
      ? t('dictation.announce.typedInto', 'Typed into {{target}}', { target: title })
      : t('dictation.announce.insertedIn', 'Inserted in {{target}}', { target: title }),
  open: (t: Translate) => t('dictation.pill.open', 'Open'),
  listening: (t: Translate) => t('dictation.pill.listening', 'Listening'),
  starting: (t: Translate) => t('dictation.pill.starting', 'Starting'),
  finishing: (t: Translate) => t('dictation.pill.finishing', 'Finishing'),
  stopped: (t: Translate) => t('dictation.pill.stopped', 'Dictation stopped'),
  label: (target: string, duration: string, t: Translate) =>
    t('dictation.pill.label', 'Dictation to {{target}}, {{duration}}', {
      target,
      duration
    }),
  hint: (t: Translate) => t('dictation.pill.hint', 'Double-tap to go back')
}
