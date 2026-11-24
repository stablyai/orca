import { ActivityIndicator, Text, View } from 'react-native'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { SectionPendingCreation } from '../../worktree/workspace-list/workspace-list-types'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { worktreeListRowStyles as styles } from '../../worktree/row-presentation/worktree-list-row-styles'
import { colors } from '../../theme/mobile-theme'

// On the workspace row's grid, so the row that replaces it lands where it was.
export function HostPendingCreationRow({ creation }: { creation: SectionPendingCreation }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={styles.worktreeRow} accessibilityRole="progressbar">
      <View style={styles.indicatorCol}>
        <ActivityIndicator size="small" color={colors.textMuted} />
      </View>
      <View style={styles.worktreeMain}>
        <Text style={[styles.worktreeName, styles.worktreeNameMain]} numberOfLines={1}>
          {t('hostScreen.hostPendingCreationRow.creatingWorkspace', 'Creating workspace…')}
        </Text>
      </View>
      {creation.repoName ? (
        <View style={styles.trailing}>
          <Text style={styles.time} numberOfLines={1}>
            {creation.repoName}
          </Text>
        </View>
      ) : null}
    </View>
  )
}
