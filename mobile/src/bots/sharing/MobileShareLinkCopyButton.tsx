// A share link's copy action: the copy icon alone, named for screen readers.
import { Pressable } from 'react-native'
import { Copy } from 'lucide-react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, pressedStyle, spacing } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

export function MobileShareLinkCopyButton(props: { onPress: () => void }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('bots.share.copyLink', 'Copy link')}
      hitSlop={8}
      style={({ pressed }) => [{ padding: spacing.xs }, pressed && pressedStyle]}
      onPress={props.onPress}
    >
      <Copy size={17} color={colors.textSecondary} />
    </Pressable>
  )
}
