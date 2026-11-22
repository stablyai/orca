import { ActivityIndicator, Text, View } from 'react-native'
import { colors, spacing } from '../../theme/mobile-theme'
import { WORKTREE_ROW_LAYOUT } from '../../worktree/row-presentation/worktree-list-row-layout'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { SectionPendingCreation } from '../../worktree/workspace-list/workspace-list-types'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'

export function HostPendingCreationRow({ creation }: { creation: SectionPendingCreation }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={styles.row} accessibilityRole="progressbar">
      <View style={styles.indicator}>
        <ActivityIndicator size="small" color={colors.textMuted} />
      </View>
      <View style={styles.main}>
        <Text style={styles.title} numberOfLines={1}>
          {t('hostScreen.hostPendingCreationRow.creatingWorkspace', 'Creating workspace…')}
        </Text>
        {creation.repoName ? (
          <Text style={styles.meta} numberOfLines={1}>
            {creation.repoName}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  // Match the workspace row’s padding and indicator column so completion does not shift the row.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: WORKTREE_ROW_LAYOUT.indicatorInset
  },
  indicator: {
    width: WORKTREE_ROW_LAYOUT.indicatorWidth,
    alignItems: 'flex-start'
  },
  main: {
    flex: 1
  },
  title: {
    fontSize: 16,
    lineHeight: 20,
    color: colors.textSecondary
  },
  meta: {
    marginTop: spacing.xxs,
    fontSize: 14,
    lineHeight: 18,
    color: colors.textMuted
  }
}))
