import { StyleSheet, View } from 'react-native'
import { spacing } from '../theme/mobile-theme'
import { Banner } from './ui/Banner'

/** Shown after repeated reconnect attempts: says the phone is still trying, and opens the log. */
export function HostDiagnosticsLink({ onPress }: { onPress: () => void }): React.JSX.Element {
  return (
    <View style={styles.frame}>
      <Banner
        tone="warning"
        title="Still trying to reach the desktop"
        message="Network diagnostics show where the connection is failing."
        action={{ label: 'View network diagnostics', onPress }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  frame: { paddingTop: spacing.sm, paddingBottom: spacing.xs }
})
