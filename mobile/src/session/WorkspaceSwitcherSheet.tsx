import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Check, ChevronRight, Monitor } from 'lucide-react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { BOTTOM_DRAWER_HIDE_DURATION_MS } from '../components/bottom-drawer-constants'
import { StatusDot } from '../components/StatusDot'
import { useRpcClientContext } from '../transport/client-context'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { RecentWorkspace } from '../worktree/recent-workspaces'
import type { WorkspaceSwitcher } from './use-workspace-switcher'

type Props = {
  switcher: WorkspaceSwitcher
  currentHostId: string
  currentWorktreeId: string
}

export function WorkspaceSwitcherSheet({ switcher, currentHostId, currentWorktreeId }: Props) {
  const { visible, close, groups, switchToWorkspace, switchToHost } = switcher
  const { getKnownState } = useRpcClientContext()
  const [closing, setClosing] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (visible) {
      setClosing(false)
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [visible])

  // Why: navigating while the drawer's Modal is still up races its dismissal on iOS and Android.
  const closeThen = useCallback(
    (run: () => void) => {
      setClosing(true)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        close()
        run()
      }, BOTTOM_DRAWER_HIDE_DURATION_MS)
    },
    [close]
  )

  const renderWorkspace = (item: RecentWorkspace) => {
    const current = item.hostId === currentHostId && item.worktreeId === currentWorktreeId
    return (
      <Pressable
        key={item.worktreeId}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        disabled={current}
        onPress={() => closeThen(() => switchToWorkspace(item))}
        accessibilityRole="button"
        accessibilityLabel={`Switch to ${item.name || item.worktreeId}`}
      >
        <Text style={[styles.rowText, current && styles.rowTextCurrent]} numberOfLines={1}>
          {item.name || item.worktreeId}
        </Text>
        {current ? <Check size={14} color={colors.textPrimary} /> : null}
      </Pressable>
    )
  }

  return (
    <BottomDrawer visible={visible && !closing} onClose={close} dragContentToDismiss={false}>
      <View style={styles.header}>
        <Text style={styles.title}>Switch workspace</Text>
        <Text style={styles.hint}>Swipe the title to flip to the last one</Text>
      </View>
      <ScrollView style={styles.scroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {groups.map((group) => (
          <View key={group.hostId} style={styles.group}>
            <Pressable
              style={({ pressed }) => [styles.hostRow, pressed && styles.rowPressed]}
              onPress={() => closeThen(() => switchToHost(group.hostId))}
              accessibilityRole="button"
              accessibilityLabel={`Open ${group.hostName} workspace list`}
            >
              <StatusDot state={getKnownState(group.hostId) ?? 'disconnected'} />
              <Monitor size={14} color={colors.textSecondary} />
              <Text style={styles.hostName} numberOfLines={1}>
                {group.hostName}
              </Text>
              <Text style={styles.hostAction}>All</Text>
              <ChevronRight size={14} color={colors.textMuted} />
            </Pressable>
            {group.workspaces.length > 0 ? (
              group.workspaces.map(renderWorkspace)
            ) : (
              <Text style={styles.empty}>No recent workspaces</Text>
            )}
          </View>
        ))}
      </ScrollView>
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm
  },
  title: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textMuted
  },
  hint: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginTop: 2
  },
  scroll: {
    maxHeight: 480,
    flexGrow: 0
  },
  group: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    overflow: 'hidden',
    marginBottom: spacing.sm
  },
  hostRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  hostName: {
    flex: 1,
    minWidth: 0,
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  hostAction: {
    fontSize: typography.metaSize,
    color: colors.textMuted
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingLeft: spacing.xl + spacing.sm,
    paddingRight: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    fontSize: typography.bodySize,
    color: colors.textSecondary
  },
  rowTextCurrent: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  empty: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    paddingVertical: spacing.sm,
    paddingLeft: spacing.xl + spacing.sm
  }
})
