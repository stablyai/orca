import * as Clipboard from 'expo-clipboard'
import { Linking } from 'react-native'
import { triggerError, triggerSelection, triggerSuccess } from './haptics'
import type { MobilePrShellOperations } from './mobile-pr-shell-operations'

export const NATIVE_MOBILE_PR_SHELL_OPERATIONS: MobilePrShellOperations = {
  selection: triggerSelection,
  success: triggerSuccess,
  error: triggerError,
  async writeClipboard(text) {
    await Clipboard.setStringAsync(text)
  },
  async openExternal(url) {
    await Linking.openURL(url)
  }
}
