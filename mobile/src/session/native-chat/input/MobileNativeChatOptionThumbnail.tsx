import { useState } from 'react'
import { Platform, Pressable, Text, View, type TextStyle } from 'react-native'
import { MobileEdgeFade } from '../../../components/MobileEdgeFade'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography, pressedStyle } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'

const MAX_HEIGHT = 96 - spacing.sm * 2

export function MobileNativeChatOptionThumbnail({
  label,
  preview,
  onPress
}: {
  label: string
  preview: string
  onPress: () => void
}): React.JSX.Element {
  return (
    <MeasuredPreviewThumbnail key={preview} label={label} preview={preview} onPress={onPress} />
  )
}

function MeasuredPreviewThumbnail({
  label,
  preview,
  onPress
}: {
  label: string
  preview: string
  onPress: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [width, setWidth] = useState(0)
  const [bounds, setBounds] = useState<{ width: number; height: number } | null>(null)
  const scale = bounds && width > 0 ? Math.min(1, width / Math.max(1, bounds.width)) : 0
  const height = bounds && width > 0 ? Math.min(MAX_HEIGHT, bounds.height * scale) : MAX_HEIGHT

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('chat.ask.optionPreview', '{{option}} preview', { option: label })}
      onPress={onPress}
      style={({ pressed }) => [styles.thumbnail, pressed && pressedStyle]}
    >
      <View
        pointerEvents="none"
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={[styles.image, { height }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text
          allowFontScaling={false}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout
            setBounds((previous) =>
              previous?.width === width && previous.height === height ? previous : { width, height }
            )
          }}
          style={[styles.text, { transform: [{ scale }] }]}
        >
          {preview}
        </Text>
        {height >= MAX_HEIGHT ? <MobileEdgeFade edge="bottom" /> : null}
      </View>
      <Text style={styles.view}>{t('chat.ask.viewPreview', 'View')}</Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  thumbnail: {
    minHeight: 44,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.control,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden'
  },
  // Native rows measure absolute Text intrinsically; the web uses its explicit CSS width below.
  image: { position: 'relative', flexDirection: 'row', overflow: 'hidden' },
  text: {
    position: 'absolute',
    ...(Platform.OS === 'web'
      ? {
          whiteSpace: 'pre' as const,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RN Web accepts intrinsic CSS widths; this branch never reaches native.
          width: 'max-content' as TextStyle['width']
        }
      : {}),
    top: 0,
    left: 0,
    transformOrigin: 'top left',
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: typography.metaSize * 1.25,
    color: colors.textPrimary,
    includeFontPadding: false
  },
  view: {
    alignSelf: 'flex-end',
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600',
    position: 'absolute',
    right: spacing.xs,
    bottom: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised
  }
}))
