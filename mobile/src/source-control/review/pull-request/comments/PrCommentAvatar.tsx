import { Text, View } from 'react-native'
import { radii, type MobilePalette } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'

const AVATAR_TONES = [
  'accentBlue',
  'statusPurple',
  'statusAmber',
  'statusGreen',
  'statusRed'
] as const

function avatarTone(login: string, colors: MobilePalette): string {
  let hash = 0
  for (const char of login) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0
  }
  return colors[AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length]]
}

// Initials on a tint of a colour picked by login, so the same person reads the same in every thread.
export function PrCommentAvatar({
  login,
  label,
  size = 28
}: {
  login: string
  /** The letters drawn, when not the login's first two: a name's initials. */
  label?: string
  size?: number
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const name = login.replace(/\[bot\]$/i, '')
  const tone = avatarTone(name, colors)
  return (
    <View
      style={[styles.avatar, { width: size, height: size, backgroundColor: `${tone}33` }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[styles.initials, { color: tone, fontSize: Math.round(size * 0.36) }]}>
        {label ?? name.slice(0, 2).toUpperCase()}
      </Text>
    </View>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  avatar: { borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  initials: { fontWeight: '700' }
}))
