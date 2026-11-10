import { useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { MobileEdgeFade } from '../../../components/MobileEdgeFade'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography, pressedStyle } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { optionPreviewFont, prepareOptionPreview } from './mobile-native-chat-option-preview'

const MAX_HEIGHT = 96

export function MobileNativeChatOptionThumbnail({
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
  const { lines, columns } = useMemo(() => prepareOptionPreview(preview), [preview])
  // Menlo and Android monospace advance ~0.6em; leave room for fallback glyphs.
  const fontSize = Math.max(4, Math.min(typography.metaSize, width / (columns * 0.65)))
  const sourceWidth = columns * fontSize * 0.65
  const scale = width > 0 ? Math.min(1, width / sourceWidth) : 0
  const lineHeight = fontSize * 1.25
  const visibleLines = Math.max(1, Math.ceil(MAX_HEIGHT / (lineHeight * (scale || 1))))
  const height = Math.min(MAX_HEIGHT, lines.length * lineHeight * scale)
  const text = useMemo(() => lines.slice(0, visibleLines).join('\n'), [lines, visibleLines])

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('chat.ask.optionPreview', '{{option}} preview', { option: label })}
      onPress={onPress}
      style={({ pressed }) => [styles.thumbnail, pressed && pressedStyle]}
    >
      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={[styles.image, { height: width > 0 ? height : MAX_HEIGHT }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {width > 0 ? (
          <Text
            allowFontScaling={false}
            style={[
              styles.text,
              { fontSize, lineHeight, width: sourceWidth, transform: [{ scale }] }
            ]}
          >
            {text}
          </Text>
        ) : null}
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
  image: { overflow: 'hidden' },
  text: {
    position: 'absolute',
    top: 0,
    left: 0,
    transformOrigin: 'top left',
    fontFamily: optionPreviewFont,
    color: colors.textPrimary,
    includeFontPadding: false
  },
  view: {
    alignSelf: 'flex-end',
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600',
    marginTop: spacing.xs
  }
}))
