import { Pressable, Text, View } from 'react-native'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { Translate } from '../i18n/mobile-i18n'
import { mobileSessionReviewCommentStyles as styles } from '../source-control/review/review-notes/mobile-session-review-comment-styles'
import { colors, pressedStyle } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { DocumentEditDraftOffer } from './use-document-edit-draft'

function savedAtLabel(savedAt: number): string {
  const saved = new Date(savedAt)
  const today = saved.toDateString() === new Date().toDateString()
  return new Intl.DateTimeFormat(getUiIntlLocale(), {
    ...(today ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit'
  }).format(saved)
}

/** What the offer says: when the edits are from, and whether the desktop file moved on since. */
export function documentEditDraftOfferText(offer: DocumentEditDraftOffer, t: Translate): string {
  const time = savedAtLabel(offer.savedAt)
  return offer.baseMatches
    ? t('files.unsavedEditsOffer.unsavedFrom', 'Unsaved edits from {{time}}', { time })
    : t(
        'files.unsavedEditsOffer.changedSince',
        'Changed on desktop since your edits from {{time}}',
        { time }
      )
}

/** The editor's floating bar while edits from before a kill wait for Restore or Discard. */
export function DocumentEditDraftOfferBar({
  offer,
  bottom,
  onDiscard,
  onRestore,
  onCopy
}: {
  offer: DocumentEditDraftOffer
  bottom: number
  onDiscard: () => void
  onRestore: () => void
  onCopy: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View pointerEvents="box-none" style={[styles.markdownFloatingBar, { bottom }]}>
      <Text
        style={[
          styles.markdownFloatingStatus,
          offer.baseMatches ? null : { color: colors.statusAmber }
        ]}
        numberOfLines={2}
      >
        {documentEditDraftOfferText(offer, t)}
      </Text>
      <View style={styles.markdownFloatingActions}>
        <Pressable
          style={({ pressed }) => [styles.markdownFloatingButton, pressed && pressedStyle]}
          onPress={onDiscard}
          accessibilityRole="button"
        >
          <Text style={styles.markdownFloatingButtonText}>
            {t('files.unsavedEditsOffer.discard', 'Discard')}
          </Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.markdownFloatingButton,
            styles.markdownSaveButton,
            pressed && pressedStyle
          ]}
          onPress={offer.baseMatches ? onRestore : onCopy}
          accessibilityRole="button"
        >
          <Text style={styles.markdownFloatingButtonText}>
            {offer.baseMatches
              ? t('files.unsavedEditsOffer.restore', 'Restore')
              : t('files.unsavedEditsOffer.copyMyEdits', 'Copy My Edits')}
          </Text>
        </Pressable>
      </View>
    </View>
  )
}
