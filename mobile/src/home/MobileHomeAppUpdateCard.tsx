import { StyleSheet, View } from 'react-native'
import { undismissedAppUpdate } from '../app-update/app-update-checker'
import {
  appUpdateChecker,
  openAppUpdate,
  useAppUpdateState
} from '../app-update/app-update-runtime'
import { AppUpdateCard } from './AppUpdateCard'
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
