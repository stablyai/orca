import { AppState } from 'react-native'
import type { StructuredAgentSessionViewerVisibility } from '../../../../../src/shared/agent-session/view/live-read/structured-agent-session-coalescer'

/** In the background, a chat's streaming text merges until the app is active again. */
export const mobileAppViewerVisibility: StructuredAgentSessionViewerVisibility = {
  hidden: () => AppState.currentState !== 'active',
  subscribeShown: (shown) => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        shown()
      }
    })
    return () => subscription.remove()
  }
}
