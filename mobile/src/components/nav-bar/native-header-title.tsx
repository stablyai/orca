import { Platform, Pressable, Text, View } from 'react-native'
import { colors, pressedStyle } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { ScreenHeaderSubtitle } from './screen-header-props'

/** A stack header title with a status line under it, or one that opens the item's details. */
export function NativeHeaderTitle({
  title,
  subtitle,
  onPress,
  accessibilityHint
}: {
  title: string
  subtitle?: ScreenHeaderSubtitle
  onPress?: () => void
  accessibilityHint?: string
}) {
  useMobileColorScheme()
  const body = (
    <>
      <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>
      {subtitle ? (
        <View style={styles.subtitleRow}>
          {subtitle.dotColor ? (
            <View style={[styles.dot, { backgroundColor: subtitle.dotColor }]} />
          ) : null}
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle.text}
          </Text>
        </View>
      ) : null}
    </>
  )
  if (!onPress) {
    return <View style={styles.block}>{body}</View>
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      hitSlop={8}
      style={({ pressed }) => [styles.block, pressed && pressedStyle]}
    >
      {body}
    </Pressable>
  )
}

// iOS centres a 17pt semibold title; Material's top app bar starts a 22sp title at the leading edge.
const ANDROID = Platform.OS === 'android'

const styles = themedStyleSheet(() => ({
  block: {
    alignItems: ANDROID ? 'flex-start' : 'center',
    maxWidth: ANDROID ? undefined : 220
  },
  title: {
    color: colors.textPrimary,
    fontSize: ANDROID ? 22 : 17,
    fontWeight: ANDROID ? '400' : '600'
  },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 12
  }
}))
