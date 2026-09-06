import { StyleSheet, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'

type Props = {
  assignee?: string
  priorityName?: string
  projectName: string
}

// Mirrors the Linear branch of the detail sheet's meta grid; the sheet owns the
// grid container, so this only contributes the rows Jira can fill.
export function JiraDetailMeta({ assignee, priorityName, projectName }: Props) {
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

const styles = StyleSheet.create({
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
})
