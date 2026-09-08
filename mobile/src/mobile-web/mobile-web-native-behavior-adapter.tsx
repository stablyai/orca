import { Alert, BackHandler } from 'react-native'
import { useMobileWebNativeShell } from '../../../src/mobile-web/src/native-shell-channel'
import { installMobileWebHardwareBackHandler } from '../../../src/mobile-web/src/mobile-web-hardware-back-handler'
import { MobileWebAlertAdapter, installMobileWebAlertAdapter } from './mobile-web-alert-adapter'
import {
  dispatchMobileWebBackNavigation,
  installMobileWebBackNavigationAdapter
} from './mobile-web-back-navigation-adapter'

let hardwareBackHandlerInstalled = false

export function installMobileWebNativeBehaviorAdapters(): void {
  installMobileWebAlertAdapter(Alert)
  installMobileWebBackNavigationAdapter(BackHandler, window)
  if (!hardwareBackHandlerInstalled) {
    installMobileWebHardwareBackHandler(() => dispatchMobileWebBackNavigation(window))
    hardwareBackHandlerInstalled = true
  }
}

export function MobileWebNativeBehaviorAdapter() {
  const shell = useMobileWebNativeShell()
  const client = shell.client
  return (
    <MobileWebAlertAdapter
      presentNative={client ? (payload) => client.native.alert(payload) : undefined}
    />
  )
}
