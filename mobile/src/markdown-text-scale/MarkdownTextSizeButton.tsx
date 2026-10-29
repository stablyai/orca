import { useState } from 'react'
import { Pressable, type StyleProp, type ViewStyle } from 'react-native'
import { Type } from 'lucide-react-native'
import { PickerModal } from '../components/PickerModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MARKDOWN_TEXT_SCALES, snapMarkdownTextScale } from './markdown-text-scales'

const OPTIONS = MARKDOWN_TEXT_SCALES.map((scale) => ({
  value: String(scale),
  label: `${Math.round(scale * 100)}%`
}))

export function MarkdownTextSizeButton({
  textScale,
  onSelect,
  style
}: {
  textScale: number
  onSelect: (scale: number) => void
  style?: StyleProp<ViewStyle>
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [open, setOpen] = useState(false)
  const label = t('markdownTextScale.button', 'Markdown text size')
  return (
    <>
      <Pressable
        style={({ pressed }) => [styles.button, pressed && styles.pressed, style]}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => setOpen(true)}
      >
        <Type size={14} color={colors.textMuted} />
      </Pressable>
      <PickerModal
        visible={open}
        title={label}
        options={OPTIONS}
        selected={String(snapMarkdownTextScale(textScale))}
        onSelect={(value) => {
          onSelect(Number(value))
        }}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    width: 34,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.row
  },
  pressed: { backgroundColor: colors.bgRaised }
}))
