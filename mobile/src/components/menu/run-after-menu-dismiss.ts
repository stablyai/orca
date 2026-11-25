import { Platform } from 'react-native'

// The iOS menu is still fading out when its action fires, and a sheet can't present over it.
const IOS_MENU_DISMISS_MS = 300

/** Runs a menu action once the native menu has gone, so the sheet it opens can present. */
export function runAfterMenuDismiss(run: () => void) {
  if (Platform.OS === 'ios') {
    setTimeout(run, IOS_MENU_DISMISS_MS)
  } else {
    requestAnimationFrame(run)
  }
}
