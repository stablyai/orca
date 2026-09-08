import { MobileWebBrowserRequestClient } from './mobile-web-browser-request-client'
import { MobileWebNavigationRequestClient } from './mobile-web-navigation-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export function mobileWebBrowserNavigationClientBindings(requests: MobileWebOneShotRequestClient) {
  const browser = new MobileWebBrowserRequestClient(requests)
  const navigation = new MobileWebNavigationRequestClient(requests)
  return {
    browserNavigate: browser.navigate.bind(browser),
    browserPointer: browser.pointer.bind(browser),
    browserKeyboard: browser.keyboard.bind(browser),
    browserDialog: browser.dialog.bind(browser),
    browserBack: browser.back.bind(browser),
    browserForward: browser.forward.bind(browser),
    browserReload: browser.reload.bind(browser),
    navigationRoute: navigation.route.bind(navigation),
    navigationReconnect: navigation.reconnect.bind(navigation),
    navigationRemoveHost: navigation.removeHost.bind(navigation)
  }
}
