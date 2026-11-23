// The words for a Google sign-in's access level on the phone, as the computer's picker has them.
import type { GoogleAccess } from '../../../../../../src/shared/google/google-scopes'
import type { Translate } from '../../../../i18n/mobile-i18n'

export function googleAccessLabel(t: Translate, access: GoogleAccess): string {
  return access === 'read-draft'
    ? t('chat.botCards.google.access.readDraft', 'Read-only + Gmail drafts')
    : t('chat.botCards.google.access.full', 'Full access')
}

export function googleAccessDescription(t: Translate, access: GoogleAccess): string {
  return access === 'read-draft'
    ? t(
        'chat.botCards.google.access.readDraftDescription',
        'Read mail, events and files, and write, edit or delete Gmail drafts. Google refuses sending mail and every other change.'
      )
    : t(
        'chat.botCards.google.access.fullDescription',
        'Read, send, create and change what the services above allow'
      )
}
