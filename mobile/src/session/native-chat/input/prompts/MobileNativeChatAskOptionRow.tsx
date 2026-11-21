import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Check } from '../../../../components/icons/app-icons'
import { MobileNativeChatOptionThumbnail } from '../session-options/MobileNativeChatOptionThumbnail'
import { colors, radii, spacing, typography, pressedStyle } from '../../../../theme/mobile-theme'
import { ASK_CHOICE_RADIUS } from './MobileNativeChatAsk.styles'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'

export function MobileNativeChatAskOptionRow({
  label,
  description,
  recommended,
  preview,
  onPreview,
  selected,
  multi,
  disabled,
  pending = false,
  onPress
}: {
  label: string
  description?: string
  recommended?: boolean
  /** Read-only inspection is separate from choosing the option. */
  preview?: string
  onPreview?: () => void
  selected: boolean
  multi?: boolean
  disabled: boolean
  /** This choice is the answer being sent (a card with no Submit). */
  pending?: boolean
  onPress: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const hasPreview = Boolean(preview && onPreview)
  const row = (
    <Pressable
      accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityState={{ checked: selected, disabled, busy: pending }}
      aria-busy={pending}
      style={({ pressed }) => [
        styles.option,
        selected && styles.optionSelected,
        hasPreview && styles.optionWithPreview,
        pressed && pressedStyle
      ]}
      disabled={disabled}
      onPress={onPress}
    >
      {/* Multi-select reads as a checkbox (square); single-select as a radio (circle). */}
      {pending ? (
        <ActivityIndicator size="small" color={colors.statusGreen} style={styles.checkSlot} />
      ) : (
        <View
          style={[
            styles.check,
            multi ? styles.checkSquare : styles.checkCircle,
            selected && styles.checkOn
          ]}
        >
          {selected ? <Check size={12} color={colors.bgBase} strokeWidth={3} /> : null}
        </View>
      )}
      <View style={styles.optionBody}>
        <Text style={styles.optionLabel}>
          {label}
          {recommended ? (
            <Text style={styles.recommended}>
              {'  '}
              {t('chat.ask.recommended', 'Recommended')}
            </Text>
          ) : null}
        </Text>
        {description ? (
          <Text style={styles.optionDescription} numberOfLines={3}>
            {description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
  return hasPreview ? (
    <View style={[styles.optionCard, selected && styles.optionSelected]}>
      {row}
      <View style={styles.previewInset}>
        <MobileNativeChatOptionThumbnail label={label} preview={preview!} onPress={onPreview!} />
      </View>
    </View>
  ) : (
    row
  )
}

const CHECK_SIZE = 18
const CHOICE_GAP = 10
const CHOICE_PADDING_X = spacing.md

// Choices sit on the card unfilled, edged at 3:1 against it, so dark mode is no longer grey on grey.
const styles = themedStyleSheet(() => ({
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: CHOICE_GAP,
    paddingVertical: 10,
    paddingHorizontal: CHOICE_PADDING_X,
    borderRadius: ASK_CHOICE_RADIUS,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.choiceBorder,
    marginBottom: 6
  },
  optionSelected: {
    borderColor: colors.statusGreen,
    backgroundColor: colors.choiceSelectedFill
  },
  checkSlot: {
    width: CHECK_SIZE,
    height: CHECK_SIZE
  },
  check: {
    width: CHECK_SIZE,
    height: CHECK_SIZE,
    borderWidth: 1.5,
    borderColor: colors.textSecondary,
    alignItems: 'center',
    justifyContent: 'center'
  },
  checkCircle: {
    borderRadius: radii.pill
  },
  checkSquare: {
    borderRadius: radii.mark
  },
  checkOn: {
    backgroundColor: colors.statusGreen,
    borderColor: colors.statusGreen
  },
  optionBody: {
    flex: 1,
    gap: 2
  },
  optionLabel: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  recommended: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '400'
  },
  optionDescription: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18
  },
  optionCard: {
    borderWidth: 1,
    borderColor: colors.choiceBorder,
    borderRadius: ASK_CHOICE_RADIUS,
    backgroundColor: 'transparent',
    marginBottom: 6
  },
  // The card carries the edge and fill; the row inside it draws neither.
  optionWithPreview: {
    borderWidth: 0,
    marginBottom: 0,
    backgroundColor: 'transparent'
  },
  previewInset: {
    marginLeft: CHOICE_PADDING_X + CHECK_SIZE + CHOICE_GAP,
    marginRight: CHOICE_PADDING_X,
    marginBottom: 10
  }
}))
