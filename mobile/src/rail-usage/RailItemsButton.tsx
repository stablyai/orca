import { Pressable, Text, View } from 'react-native'
import { ListChecks } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { feedback, radii } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'

/** Round side-rail button that opens the bots Items view, with an optional Needs you badge. */
export function RailItemsButton({
  size,
  needsYou = 0,
  active = false,
  onPress
}: {
  size: number
  needsYou?: number
  active?: boolean
  onPress: () => void
}): React.JSX.Element {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        needsYou > 0
          ? t('session.header.itemsNeedYou', 'Items, {{count}} need you', { count: needsYou })
          : t('session.header.items', 'Items')
      }
      accessibilityState={{ selected: active }}
      hitSlop={size >= 44 ? 4 : 6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { width: size, height: size },
        active && styles.active,
        pressed && styles.pressed
      ]}
      testID="rail-items-button"
    >
      <ListChecks
        size={Math.round(size / 2)}
        color={active ? colors.bgBase : colors.textPrimary}
        strokeWidth={2.1}
      />
      {needsYou > 0 ? (
        <View style={styles.badge} pointerEvents="none" testID="rail-items-badge">
          <Text style={styles.badgeText} allowFontScaling={false}>
            {needsYou > 99 ? '99+' : needsYou}
          </Text>
        </View>
      ) : null}
    </Pressable>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  button: {
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  active: {
    backgroundColor: colors.surfaceBright
  },
  pressed: {
    opacity: feedback.pressedOpacity
  },
  badge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.agentQuestion,
    borderWidth: 2,
    borderColor: colors.bgBase
  },
  badgeText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    color: '#ffffff',
    fontVariant: ['tabular-nums']
  }
}))
