import { undismissedAppUpdate } from '../app-update/app-update-checker'
import {
  appUpdateChecker,
  openAppUpdate,
  useAppUpdateState
} from '../app-update/app-update-runtime'
import { AppUpdateCard } from './AppUpdateCard'

export function MobileHomeAppUpdateCard() {
  const available = undismissedAppUpdate(useAppUpdateState())
  if (!available) {
    return null
  }
  return (
    <AppUpdateCard
      version={available.version}
      onPress={() => openAppUpdate(available.url)}
      onDismiss={() => appUpdateChecker.dismiss(available.version)}
    />
  )
}
