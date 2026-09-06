import { mobileWebNativeAlertLifecycle } from './mobile-web-native-alert'
import { useMobileWebPackageSession } from './use-mobile-web-package-session'

export function useMobileWebAlertSafePackageSession(
  args: Omit<Parameters<typeof useMobileWebPackageSession>[0], 'beforeSessionReplacement'>
): ReturnType<typeof useMobileWebPackageSession> {
  return useMobileWebPackageSession({
    ...args,
    beforeSessionReplacement: mobileWebNativeAlertLifecycle.waitForIdle
  })
}
