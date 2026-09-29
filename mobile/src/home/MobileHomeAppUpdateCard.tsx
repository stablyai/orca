import { StyleSheet, View } from 'react-native'
import { undismissedAppUpdate } from '../app-update/app-update-checker'
import { appUpdateChecker } from '../app-update/app-update-runtime'
import { openAppUpdate } from '../app-update/open-app-update'
import { useAppUpdateState } from '../app-update/use-app-update-state'
import { AppUpdateCard } from '../components/AppUpdateCard'
import { spacing } from '../theme/mobile-theme'

export function MobileHomeAppUpdateCard() {
  const available = undismissedAppUpdate(useAppUpdateState())
  if (!available) {
    return null
  }
  return (
    <View style={styles.slot}>
      <AppUpdateCard
        version={available.version}
        onPress={() => openAppUpdate(available.url)}
        onDismiss={() => appUpdateChecker.dismiss(available.version)}
      />
    </View>
  )
}

const styles = StyleSheet.create({ slot: { marginBottom: spacing.lg } })
