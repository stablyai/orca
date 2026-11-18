import { Image, Text, View } from 'react-native'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { colors } from '../theme/mobile-theme'
import type { MobileBotAvatarSource } from './host-bot-row-facts'
import { mobileBotMascotAsset } from './mobile-bot-mascot-assets'

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
  return (
    <Image
      source={avatar.kind === 'mascot' ? mobileBotMascotAsset(avatar.id) : { uri: avatar.uri }}
      style={[styles.tile, frame]}
      accessibilityIgnoresInvertColors
    />
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
