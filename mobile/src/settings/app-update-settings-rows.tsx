import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { KnownAppUpdate } from '../storage/app-update-preferences'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { formatTimeAgo } from '../worktree/agent-row-display'

export type AppUpdateCheckRowStatus = 'idle' | 'checking' | 'up-to-date' | 'failed'

function checkRowValue(status: AppUpdateCheckRowStatus, lastCheckedAt: number | null, now: number) {
  if (status === 'checking') {
    return 'Checking…'
  }
  if (status === 'up-to-date') {
    return 'Up to date'
  }
  if (status === 'failed') {
    return "Couldn't check"
  }
  if (lastCheckedAt === null) {
    return 'Never'
  }
  const ago = formatTimeAgo(lastCheckedAt, now)
  return `Last checked ${ago === 'just now' ? ago : `${ago} ago`}`
}

/** Settings' version row and manual check; the update row stays after the home card is dismissed. */
export function AppUpdateSettingsRows(props: {
  installedVersion: string | null
  available: KnownAppUpdate | null
  lastCheckedAt: number | null
  now: number
  checkStatus: AppUpdateCheckRowStatus
  onUpdate: () => void
  onCheck: () => void
}) {
  const checkValue = checkRowValue(props.checkStatus, props.lastCheckedAt, props.now)
  return (
    <View style={styles.section}>
      {props.available ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Update to Orca ${props.available.version}`}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={props.onUpdate}
        >
          <Text style={styles.rowLabel}>Update to Orca {props.available.version}</Text>
          <Text style={styles.actionValue}>Update</Text>
        </Pressable>
      ) : props.installedVersion ? (
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Version {props.installedVersion}</Text>
        </View>
      ) : null}
      {props.available || props.installedVersion ? <View style={styles.separator} /> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Check for updates, ${checkValue}`}
        accessibilityState={{ busy: props.checkStatus === 'checking' }}
        disabled={props.checkStatus === 'checking'}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={props.onCheck}
      >
        <Text style={styles.rowLabel}>Check for updates</Text>
        <Text style={styles.rowValue}>{checkValue}</Text>
      </Pressable>
    </View>
  )
}

// Same panel, rows and separator as MobileSettingsSection.
const styles = StyleSheet.create({
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden',
    marginTop: spacing.md
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: { backgroundColor: colors.bgRaised },
  rowLabel: {
    flex: 1,
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  rowValue: { fontSize: typography.metaSize, color: colors.textSecondary },
  actionValue: { fontSize: typography.bodySize, fontWeight: '600', color: colors.textPrimary },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  }
})
