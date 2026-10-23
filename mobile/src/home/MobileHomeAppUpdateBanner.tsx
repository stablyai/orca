import { StyleSheet, View } from 'react-native'
import { undismissedAppUpdate } from '../app-update/app-update-checker'
import {
  appUpdateChecker,
  openAppUpdate,
  useAppUpdateState
} from '../app-update/app-update-runtime'
import { Banner } from '../components/ui/Banner'
import { spacing } from '../theme/mobile-theme'

/** Under Home's title, only while an update is available and not dismissed. */
export function MobileHomeAppUpdateBanner() {
  const available = undismissedAppUpdate(useAppUpdateState())
  if (!available) {
    return null
  }
  return (
    <View style={styles.slot}>
      <Banner
        message={`Orca ${available.version} is available.`}
        action={{ label: 'Update', onPress: () => openAppUpdate(available.url) }}
        onDismiss={() => appUpdateChecker.dismiss(available.version)}
        dismissLabel={`Dismiss Orca ${available.version} update`}
      />
    </View>
  )
}

const styles = StyleSheet.create({ slot: { marginTop: spacing.sm } })
