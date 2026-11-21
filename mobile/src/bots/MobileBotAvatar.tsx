import { Image, StyleSheet, Text, View } from 'react-native'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { colors } from '../theme/mobile-theme'
import type { MobileBotAvatarSource } from './host-bot-row-facts'
import { mobileBotMascotAsset, mobileBotMascotRimAsset } from './mobile-bot-mascot-assets'
import {
  mobileBotOutfitAsset,
  mobileBotOutfitReplacesPicture,
  OUTFIT_SHEET_COLUMNS,
  OUTFIT_SHEET_ROWS
} from './mobile-bot-outfit-assets'
import type { BotMascotId } from '../../../src/shared/bot-avatar'
import type { BotAvatarOutfit } from '../../../src/shared/bots/bot-avatar-outfit'
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
  // The mascot pictures are transparent: their tile color goes behind, on a dark one the light rim, and
  // any outfit on top.
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
      {avatar.outfit && mobileBotOutfitReplacesPicture(avatar.outfit) ? null : (
        <Image
          source={mobileBotMascotAsset(avatar.id)}
          style={[StyleSheet.absoluteFill, layer]}
          accessibilityIgnoresInvertColors
        />
      )}
      {avatar.outfit ? <OutfitLayer outfit={avatar.outfit} id={avatar.id} size={size} /> : null}
    </View>
  )
}

/** The mascot's cell of its outfit's sheet: the sheet drawn at `size` per cell, shifted under a `size` window. */
function OutfitLayer({
  outfit,
  id,
  size
}: {
  outfit: BotAvatarOutfit
  id: BotMascotId
  size: number
}) {
  const { sheet, column, row } = mobileBotOutfitAsset(outfit, id)
  return (
    <View style={[StyleSheet.absoluteFill, styles.window]}>
      <Image
        source={sheet}
        style={{
          position: 'absolute',
          left: -column * size,
          top: -row * size,
          width: size * OUTFIT_SHEET_COLUMNS,
          height: size * OUTFIT_SHEET_ROWS
        }}
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
  window: {
    overflow: 'hidden'
  },
  letter: {
    color: colors.textSecondary,
    fontWeight: '600'
  }
}))
