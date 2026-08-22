import { isTrustedUIRenderer } from './ui'

export function isTrustedBrowserRenderer(sender: Electron.WebContents): boolean {
  return isTrustedUIRenderer(sender)
}
