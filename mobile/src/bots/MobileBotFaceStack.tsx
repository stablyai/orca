import { Text, View } from 'react-native'
import {
  BOT_GROUP_FACE_GAP,
  BOT_GROUP_FACE_SLOT,
  botGroupFaces
} from '../../../src/shared/bots/bot-group-face-layout'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import type { MobileBotAvatarSource } from './host-bot-row-facts'
import { MobileBotAvatar } from './MobileBotAvatar'

/** A group's members as overlapping circles filling a bot avatar's square. */
export function MobileBotFaceStack({
  faces,
  slot = 32,
  ringColor
}: {
  faces: readonly { id: string; avatar: MobileBotAvatarSource }[]
  /** Side of the square, in pt; the row's avatar size by default. */
  slot?: number
  /** The surface behind it, which the gap between faces shows. */
  ringColor?: string
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const surface = ringColor ?? colors.bgBase
  const scale = slot / BOT_GROUP_FACE_SLOT
  const gap = BOT_GROUP_FACE_GAP * scale
  return (
    <View
      style={{ width: slot, height: slot }}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {botGroupFaces(faces, (face) => face.id, 1, true).map((face, index) => {
        const size = face.size * scale
        // Later circles sit on earlier ones; a ring in the row's colour keeps them apart.
        const ring = index > 0 ? gap : 0
        return (
          <View
            key={face.key}
            style={[
              styles.ring,
              {
                borderColor: surface,
                left: face.x * scale - ring,
                top: face.y * scale - ring,
                borderWidth: ring,
                borderRadius: size / 2 + ring
              }
            ]}
          >
            {'member' in face.face ? (
              <MobileBotAvatar avatar={face.face.member.avatar} size={size} circular />
            ) : (
              <View style={[styles.more, { width: size, height: size, borderRadius: size / 2 }]}>
                <Text style={[styles.moreText, { fontSize: Math.round(face.font * scale) }]}>
                  +{face.face.more}
                </Text>
              </View>
            )}
          </View>
        )
      })}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  ring: { position: 'absolute' },
  more: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  moreText: { fontWeight: '500', color: colors.textMuted }
}))
