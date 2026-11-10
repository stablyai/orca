import { Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

/** Marks a plain folder workspace in the list. */
export function WorktreeFolderBadge() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.badge}>
      <Text style={styles.text}>{t('components.worktreeListRow.folder', 'Folder')}</Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  badge: {
    backgroundColor: colors.bgRaised,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radii.pill
  },
  text: {
    fontSize: 10,
    color: colors.textSecondary
  }
}))
