import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import type { KnownAppUpdate } from '../storage/app-update-preferences'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { formatTimeAgo } from '../worktree/agent-row-display'
import { ListGroup } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'

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
  onUpdate: (url: string) => void
  onCheck: () => void
}) {
  const checkValue = checkRowValue(props.checkStatus, props.lastCheckedAt, props.now)
  const { available, installedVersion, onUpdate } = props
  const checking = props.checkStatus === 'checking'
  return (
    <ListGroup style={styles.group}>
      {available ? (
        <ListRow
          title={`Update to Orca ${available.version}`}
          accessibilityLabel={`Update to Orca ${available.version}`}
          accessibilityRole="link"
          accessory={<Text style={styles.updateAction}>Update</Text>}
          onPress={() => onUpdate(available.url)}
        />
      ) : installedVersion ? (
        <ListRow title="Version" value={installedVersion} />
      ) : null}
      <ListRow
        title="Check for updates"
        value={checkValue}
        accessibilityLabel={`Check for updates, ${checkValue}`}
        accessory={
          checking ? (
            <View style={styles.spinner}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
            </View>
          ) : undefined
        }
        // Why: no tap while a check runs; the spinner says so without dimming the row.
        onPress={checking ? undefined : props.onCheck}
      />
    </ListGroup>
  )
}

const styles = StyleSheet.create({
  group: { marginTop: spacing.md },
  updateAction: { ...textStyles.callout, fontWeight: '600', color: colors.accentBlue },
  spinner: { width: 20, alignItems: 'center' }
})
