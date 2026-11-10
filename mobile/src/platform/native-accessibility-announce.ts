import { AccessibilityInfo, Platform } from 'react-native'
import { a11yAnnounceParamsSchema } from '../mobile-web-shell/bridge/bridge-native-verbs'

// VoiceOver ignores the page's live regions inside the shell's WebView, so the shell announces for it; TalkBack reads them, so Android leaves it to the page.
export function serveNativeAnnounceVerb(params: unknown): { announced: boolean } {
  const { message } = a11yAnnounceParamsSchema.parse(params)
  if (Platform.OS !== 'ios') {
    return { announced: false }
  }
  AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true })
  return { announced: true }
}
