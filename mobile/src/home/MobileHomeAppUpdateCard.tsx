import { undismissedAppUpdate } from '../app-update/app-update-checker'
import {
  appUpdateChecker,
  isRetiredGithubAndroidApp,
  openAppUpdate,
  useAppUpdateState
} from '../app-update/app-update-runtime'
import { AppUpdateCard } from './AppUpdateCard'

export function MobileHomeAppUpdateCard() {
  const available = undismissedAppUpdate(useAppUpdateState())
  // The Play move card takes its place on the retired GitHub app.
  if (!available || isRetiredGithubAndroidApp) {
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
