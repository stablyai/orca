import { AppState } from 'react-native'
import type { StructuredAgentSessionViewerVisibility } from '../../../../../src/shared/agent-session/view/live-read/structured-agent-session-coalescer'

/** In the background, a chat's streaming text merges until the app comes back. An inactive app
 *  (Control Center or a call banner over it) is still on screen, so it keeps drawing. */
export const mobileAppViewerVisibility: StructuredAgentSessionViewerVisibility = {
  hidden: () => AppState.currentState === 'background',
  subscribeShown: (shown) => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'background') {
        shown()
      }
    })
    return () => subscription.remove()
  }
}
