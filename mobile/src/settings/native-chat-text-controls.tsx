import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import { MobileSlider } from '../components/controls/MobileSlider'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  defaultNativeChatTextSettings,
  NATIVE_CHAT_TEXT_SIZE_MAX,
  NATIVE_CHAT_TEXT_SIZE_MIN,
  type NativeChatLineSpacing
} from '../session/native-chat/preferences/native-chat-text-settings'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
// Shared by Chat UI settings and the session's Text size sheet, so both edit the same way.

export function nativeChatLineSpacingSegments(
  t: Translate
): { value: NativeChatLineSpacing; label: string }[] {
  return [
    { value: 'compact', label: t('settings.nativeChatText.spacingCompact', 'Compact') },
    { value: 'default', label: t('settings.nativeChatText.spacingDefault', 'Default') },
    { value: 'relaxed', label: t('settings.nativeChatText.spacingRelaxed', 'Relaxed') }
  ]
}

export function nativeChatTextSizeLabel(size: number, t: Translate): string {
  return size === defaultNativeChatTextSettings().size
    ? t('settings.nativeChatText.sizeDefault', 'Default')
    : t('settings.nativeChatText.sizePoints', '{{size}} pt', { size })
}

/** A row whose control sits under its title, for controls too wide to share the line. */
export function StackedRow({
  title,
  value,
  children
}: {
  title: string
  value?: string
  children: ReactNode
}) {
  const styles = useThemedStyles(stylesSheet)
  return (
    <View style={styles.stacked}>
      <View style={styles.stackedHeader}>
        <Text style={styles.stackedTitle}>{title}</Text>
        {value !== undefined ? <Text style={styles.stackedValue}>{value}</Text> : null}
      </View>
      {children}
    </View>
  )
}

/** The size slider between a small and a large "A". */
export function NativeChatTextSizeSlider({
  size,
  onValueChange,
  onSlidingComplete
}: {
  size: number
  onValueChange: (size: number) => void
  onSlidingComplete?: (size: number) => void
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  return (
    <View style={styles.sliderLine}>
      <Text style={styles.smallA} importantForAccessibility="no">
        A
      </Text>
      <View style={styles.slider}>
        <MobileSlider
          value={size}
          min={NATIVE_CHAT_TEXT_SIZE_MIN}
          max={NATIVE_CHAT_TEXT_SIZE_MAX}
          onValueChange={onValueChange}
          onSlidingComplete={onSlidingComplete}
          accessibilityLabel={t('settings.nativeChatText.size', 'Text size')}
          accessibilityValueText={t('settings.nativeChatText.sizeSpoken', '{{size}} points', {
            size
          })}
          testID="chat-text-size"
        />
      </View>
      <Text style={styles.largeA} importantForAccessibility="no">
        A
      </Text>
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  stacked: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.xs
  },
  stackedHeader: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  stackedTitle: { fontSize: 15, color: colors.textPrimary },
  stackedValue: { fontSize: 15, color: colors.textSecondary },
  sliderLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  slider: { flex: 1 },
  smallA: { fontSize: 13, color: colors.textSecondary },
  largeA: { fontSize: 20, color: colors.textSecondary }
}))
