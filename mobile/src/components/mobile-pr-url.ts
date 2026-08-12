import { Linking } from 'react-native'

export function openMobilePrUrl(url: string): void {
  // Prevent unhandled rejections when no app accepts the URL.
  void Linking.openURL(url).catch(() => {})
}
