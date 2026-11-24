import { defineMethod } from '../../core'
import { requestBackgroundWindowOpen } from '../../../../window/activation/background-window-open'

export const DESKTOP_WINDOW_METHODS = [
  // `orca open` asks the running app instead of relaunching it, which would hand it the foreground.
  defineMethod({
    name: 'desktop.openWindowInBackground',
    permission: 'desktop-control',
    params: null,
    handler: async () => ({ requested: requestBackgroundWindowOpen() })
  })
]
