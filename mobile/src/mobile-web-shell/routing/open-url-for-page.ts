import { Linking } from 'react-native'

// Both externalLink and cancelled navigation use this filtered opener. Report device-handler failure without throwing from a native frame callback; neither path has a reply.
export function openUrlForPage(url: string): void {
  void Linking.openURL(url).catch((error: unknown) => {
    console.warn('[web-shell] could not open a URL for the page', { url, error })
  })
}
