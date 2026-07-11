import { View, StyleSheet } from 'react-native'
import { colors, spacing } from '../theme/mobile-theme'

// Row separator for the host workspace list; inset to align with row text.
export function WorkspaceListSeparator() {
  return <View style={styles.separator} />
}

const styles = StyleSheet.create({
  separator: {
    height: 1,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.lg + 24,
    marginRight: spacing.lg
  }
})
