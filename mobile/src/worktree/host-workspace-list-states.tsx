import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import {
  selectHostWorkspaceListState,
  type HostWorkspaceListStateInput
} from './host-workspace-list-state'
import { createMobileTranslator } from '@/i18n/mobile-i18n'

const tr = createMobileTranslator('host')

export function HostWorkspaceListStates(
  props: HostWorkspaceListStateInput & {
    search: string
    activeFilterCount: number
  }
) {
  const state = selectHostWorkspaceListState(props)
  if (state === 'loading') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
      </View>
    )
  }
  if (state === 'catalog-error') {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>{tr('catalogErrorTitle')}</Text>
        <Text style={styles.catalogErrorDetail}>
          {tr('catalogErrorDetail', { catalogError: props.catalogError })}
        </Text>
      </View>
    )
  }
  if (state === 'empty') {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>
          {props.search
            ? tr('noMatching')
            : props.activeFilterCount > 0
              ? tr('noWorktreesMatch')
              : tr('noWorktrees')}
        </Text>
      </View>
    )
  }
  return null
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  catalogErrorDetail: {
    marginTop: spacing.xs,
    paddingHorizontal: spacing.lg,
    color: colors.textMuted,
    fontSize: typography.metaSize,
    textAlign: 'center'
  }
})
