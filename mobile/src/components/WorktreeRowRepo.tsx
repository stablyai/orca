import { Text, View } from 'react-native'
import type { MobileRenderableRepoIcon } from '../host-screen/host-screen-reply-schema'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileRepoIcon } from './MobileRepoIcon'

/** The project icon, and the project name when shown, in a worktree row's meta line. */
export function WorktreeRowRepo({
  name,
  showName,
  repoIcon,
  color
}: {
  name: string
  showName: boolean
  repoIcon?: MobileRenderableRepoIcon | null
  color: string
}) {
  useMobileColorScheme()
  const icon = <MobileRepoIcon repoIcon={repoIcon} size={11} color={color} />
  if (!showName) {
    // Why: with the name hidden, the icon carries the project name for screen readers.
    return (
      <View accessible accessibilityLabel={name}>
        {icon}
      </View>
    )
  }
  return (
    <>
      {icon}
      <Text style={styles.repoName} numberOfLines={1}>
        {name}
      </Text>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  repoName: {
    fontSize: 11,
    color: colors.textSecondary,
    maxWidth: 100
  }
}))
