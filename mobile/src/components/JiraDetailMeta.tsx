import { Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

type Props = {
  assignee?: string
  priorityName?: string
  projectName: string
}

// The detail sheet owns the surrounding metadata grid.
export function JiraDetailMeta({ assignee, priorityName, projectName }: Props) {
  useMobileColorScheme()
  const rows: [string, string | undefined][] = [
    ['Assignee', assignee],
    ['Priority', priorityName],
    ['Project', projectName]
  ]
  return (
    <>
      {rows.map(([label, value]) =>
        value ? (
          <View key={label} style={styles.item}>
            <Text style={styles.label}>{label}</Text>
            <Text style={styles.value}>{value}</Text>
          </View>
        ) : null
      )}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  item: {
    minWidth: 96,
    flexGrow: 1
  },
  label: {
    fontSize: 11,
    color: colors.textMuted,
    marginBottom: 2
  },
  value: {
    fontSize: 13,
    color: colors.textPrimary,
    fontWeight: '600'
  }
}))
