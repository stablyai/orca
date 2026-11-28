import { Pressable, Text, View } from 'react-native'
import { intlLocaleFor } from '../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../i18n/use-mobile-translation'
import type { Translate } from '../i18n/mobile-i18n'
import { mobileSessionReviewCommentStylesSheet } from '../source-control/review/review-notes/mobile-session-review-comment-styles'
import { feedback, pressedStyle } from '../theme/mobile-theme'
import { useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import type { DocumentEditDraftOffer } from './use-document-edit-draft'

function savedAtLabel(savedAt: number, intlLocale: string): string {
  const saved = new Date(savedAt)
  const today = saved.toDateString() === new Date().toDateString()
  return new Intl.DateTimeFormat(intlLocale, {
    ...(today ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit'
  }).format(saved)
}

/** What the offer says: when the edits are from, and whether the desktop file moved on since. */
export function documentEditDraftOfferText(
  offer: DocumentEditDraftOffer,
  t: Translate,
  intlLocale: string
): string {
  const time = savedAtLabel(offer.savedAt, intlLocale)
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
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const intlLocale = intlLocaleFor(useMobileUiLocale())
  return (
    <DocumentFloatingBar
      bottom={bottom}
      status={documentEditDraftOfferText(offer, t, intlLocale)}
      statusColor={offer.baseMatches ? undefined : colors.statusAmber}
      quiet={{ label: t('files.unsavedEditsOffer.discard', 'Discard'), onPress: onDiscard }}
      primary={
        offer.baseMatches
          ? { label: t('files.unsavedEditsOffer.restore', 'Restore'), onPress: onRestore }
          : { label: t('files.unsavedEditsOffer.copyMyEdits', 'Copy My Edits'), onPress: onCopy }
      }
    />
  )
}

const DISABLED = { opacity: feedback.disabledOpacity }

type DocumentFloatingBarAction = { label: string; onPress: () => void; disabled?: boolean }

/** A floating status line over an open editor with a quiet and a primary action. */
export function DocumentFloatingBar({
  bottom,
  status,
  statusColor,
  quiet,
  primary
}: {
  bottom: number
  status: string
  statusColor?: string
  quiet: DocumentFloatingBarAction
  primary: DocumentFloatingBarAction
}) {
  const styles = useThemedStyles(mobileSessionReviewCommentStylesSheet)
  return (
    <View pointerEvents="box-none" style={[styles.markdownFloatingBar, { bottom }]}>
      <Text
        style={[styles.markdownFloatingStatus, statusColor ? { color: statusColor } : null]}
        numberOfLines={2}
      >
        {status}
      </Text>
      <View style={styles.markdownFloatingActions}>
        <Pressable
          style={({ pressed }) => [
            styles.markdownFloatingButton,
            pressed && pressedStyle,
            quiet.disabled && DISABLED
          ]}
          onPress={quiet.onPress}
          disabled={quiet.disabled}
          accessibilityRole="button"
          accessibilityState={{ disabled: quiet.disabled === true }}
        >
          <Text style={styles.markdownFloatingButtonText}>{quiet.label}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.markdownFloatingButton,
            styles.markdownSaveButton,
            pressed && pressedStyle,
            primary.disabled && DISABLED
          ]}
          onPress={primary.onPress}
          disabled={primary.disabled}
          accessibilityRole="button"
          accessibilityState={{ disabled: primary.disabled === true }}
        >
          <Text style={styles.markdownFloatingButtonText}>{primary.label}</Text>
        </Pressable>
      </View>
    </View>
  )
}
