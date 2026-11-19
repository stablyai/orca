import { Image, StyleSheet, Text, View } from 'react-native'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { colors } from '../theme/mobile-theme'
import type { MobileBotAvatarSource } from './host-bot-row-facts'
import { mobileBotMascotAsset, mobileBotMascotRimAsset } from './mobile-bot-mascot-assets'
import {
  DEFAULT_BOT_AVATAR_COLOR,
  isDarkBotAvatarColor
} from '../../../src/shared/bots/bot-avatar-color'

/** The bot's picture as the desktop sidebar draws it: a mascot, its upload, or its emoji or initial. */
export function MobileBotAvatar({
  avatar,
  size = 16,
  circular = false
}: {
  avatar: MobileBotAvatarSource
  size?: number
  circular?: boolean
}) {
  useMobileColorScheme()
  const frame = { width: size, height: size, borderRadius: circular ? size / 2 : size / 4 }
  if (avatar.kind === 'text') {
    return (
      <View style={[styles.tile, frame]}>
        <Text style={[styles.letter, { fontSize: Math.round(size * 0.6) }]}>{avatar.text}</Text>
      </View>
    )
  }
  if (avatar.kind === 'image') {
    return (
      <Image
        source={{ uri: avatar.uri }}
        style={[styles.tile, frame]}
        accessibilityIgnoresInvertColors
      />
    )
  }
  // The mascot pictures are transparent: their tile color goes behind, and on a dark one the light rim.
  const color = avatar.color ?? DEFAULT_BOT_AVATAR_COLOR
  // A bundled picture keeps its own pixel size unless told otherwise.
  const layer = { width: size, height: size }
  return (
    <View style={[styles.tile, frame, { backgroundColor: color }]}>
      {isDarkBotAvatarColor(color) ? (
        <Image
          source={mobileBotMascotRimAsset(avatar.id)}
          style={[StyleSheet.absoluteFill, layer]}
          accessibilityIgnoresInvertColors
        />
      ) : null}
      <Image
        source={mobileBotMascotAsset(avatar.id)}
        style={[StyleSheet.absoluteFill, layer]}
        accessibilityIgnoresInvertColors
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  tile: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    overflow: 'hidden'
  },
  letter: {
    color: colors.textSecondary,
    fontWeight: '600'
  }
}))
