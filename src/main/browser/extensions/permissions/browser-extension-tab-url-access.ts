import { getChromeExtensionOrigin } from '../../../../shared/browser/extensions/browser-extension-url'
import { extensionHasPermission } from '../api-runtime/browser-extension-namespace-registry'
import { hasBrowserExtensionHostPermission } from './browser-extension-permission-grants'
import { browserExtensionHostPatternsInSession } from './browser-extension-session-permissions'
import { hasBrowserExtensionActiveTab } from './browser-extension-active-tab'

/** Chrome shows url/title with "tabs" or a matching host permission, optional grants included. */
export function canExtensionSeeTabUrl(
  extension: Electron.Extension,
  sess: Electron.Session,
  url: string,
  tabId?: number
): boolean {
  return (
    url.startsWith(`${getChromeExtensionOrigin(extension.id)}/`) ||
    extensionHasPermission(extension, 'tabs', sess) ||
    (tabId !== undefined && hasBrowserExtensionActiveTab(extension.id, tabId)) ||
    hasBrowserExtensionHostPermission(browserExtensionHostPatternsInSession(extension, sess), url)
  )
}
