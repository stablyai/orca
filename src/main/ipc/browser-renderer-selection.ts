import { browserManager } from '../browser/browser-manager'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

export function selectTrustedBrowserRenderer(sender: Electron.WebContents): boolean {
  if (!isTrustedBrowserRenderer(sender)) {
    return false
  }
  browserManager.selectNativeRenderer(sender.id)
  return true
}
