import type { Translate } from '../../i18n/mobile-i18n'
import {
  BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN,
  type BrowserSitePermission
} from '../../../../src/shared/browser/site-settings/browser-site-permission'

// Same wording as the desktop's prompt (browser-site-permission-copy.ts).

export function mobileBrowserSiteName(origin: string, t: Translate): string {
  if (origin === BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN) {
    return t('browser.pagePrompt.localFiles', 'Local files')
  }
  return origin.startsWith('https://') ? origin.slice('https://'.length) : origin
}

/** What the site asks to do, finishing "{site} wants to". */
export function mobileBrowserPermissionLine(
  permission: BrowserSitePermission,
  t: Translate
): string {
  switch (permission) {
    case 'camera':
      return t('browser.pagePrompt.ask.camera', 'Use your camera')
    case 'microphone':
      return t('browser.pagePrompt.ask.microphone', 'Use your microphone')
    case 'location':
      return t('browser.pagePrompt.ask.location', 'Know your location')
    case 'notifications':
      return t('browser.pagePrompt.ask.notifications', 'Show notifications')
    case 'clipboard':
      return t('browser.pagePrompt.ask.clipboard', 'See text and images copied to the clipboard')
    case 'midi':
      return t('browser.pagePrompt.ask.midi', 'Use your MIDI devices')
    case 'window-management':
      return t('browser.pagePrompt.ask.windowManagement', 'Manage windows on all your displays')
    case 'idle-detection':
      return t(
        'browser.pagePrompt.ask.idleDetection',
        'Know when you are actively using this device'
      )
    case 'local-network':
      return t(
        'browser.pagePrompt.ask.localNetwork',
        'Access apps on this device and devices on your local network'
      )
  }
}
