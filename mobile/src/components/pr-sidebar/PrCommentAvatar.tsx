import { Text, View } from 'react-native'
import { colors, radii } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

const AVATAR_TONES = [
  'accentBlue',
  'statusPurple',
  'statusAmber',
  'statusGreen',
  'statusRed'
] as const

function avatarTone(login: string): string {
  let hash = 0
  for (const char of login) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0
  }
  return colors[AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length]]
}

// Initials on a tint of a colour picked by login, so the same person reads the same in every thread.
export function PrCommentAvatar({ login, size = 28 }: { login: string; size?: number }) {
  useMobileColorScheme()
  const name = login.replace(/\[bot\]$/i, '')
  const tone = avatarTone(name)
  return (
    <View
      style={[styles.avatar, { width: size, height: size, backgroundColor: `${tone}33` }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[styles.initials, { color: tone, fontSize: Math.round(size * 0.36) }]}>
        {name.slice(0, 2).toUpperCase()}
      </Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  avatar: { borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  initials: { fontWeight: '700' }
}))
