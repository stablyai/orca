import { PencilLine } from 'lucide-react-native'
import { Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

// Under a row's real name: a rename the desktop hasn't taken yet.
export function WorktreeUnsavedName({ name }: { name: string }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.row}>
      <PencilLine size={12} color={colors.textSecondary} />
      <Text style={styles.text} numberOfLines={1}>
        {t('components.worktreeListRow.unsavedName', 'Unsaved name: {{name}}', { name })}
      </Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 2
  },
  text: {
    flexShrink: 1,
    fontSize: typography.metaSize,
    color: colors.textSecondary
  }
}))
